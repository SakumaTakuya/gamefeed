// ゲーム HTML を投稿ごとのパス（/p/<post_id>/）から配信する（se#A.2, A.4, A.5）。
// 状態を持たない。配信可否は API が書いた KV `serve:<post_id>` を読むだけ。
import { GUEST_SDK_JS } from "@gamefeed/sdk/guest-bundle";
import { baseHeaders, CSP_LOCKED, cspForPost } from "./headers.ts";
import { injectSdk } from "./inject.ts";
import { verifyPlayToken } from "./play-token.ts";

export interface Env {
  /** ゲーム HTML（`games/{hash}.html`）。 */
  GAMES: R2Bucket;
  /** 配信可否（`serve:<post_id>` → `{hash, status}`）。 */
  SERVE: KVNamespace;
  /** 試遊トークンの署名鍵。API と共有する。未設定なら下書きは配信しない。 */
  GAMES_SIGNING_SECRET?: string;
  /** `frame-ancestors` に入れるアプリのオリジン。未設定なら 'none'。 */
  APP_ORIGIN?: string;
}

/** ULID（Crockford Base32、26 文字、大文字）。 */
const POST_ID = "[0-9A-HJKMNP-TV-Z]{26}";
const UNDER_POST = new RegExp(`^/p/(${POST_ID})/`);
const HASH = /^[0-9a-f]{64}$/;

/** 404 の文言はすべて同じにする（投稿の有無・状態を漏らさない）。 */
const NOT_FOUND = "not found";

type Serve = { hash: string; status: "draft" | "ok" };

function notFound(csp: string, head: boolean): Response {
  const headers = baseHeaders(csp);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(head ? null : NOT_FOUND, { status: 404, headers });
}

/** KV の値を読む。`no`・未知・壊れた値はどれも null（配信しない）。 */
async function readServe(env: Env, postId: string): Promise<Serve | null> {
  const raw = await env.SERVE.get(`serve:${postId}`);
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { hash, status } = v as { hash?: unknown; status?: unknown };
  if (typeof hash !== "string" || !HASH.test(hash)) return null;
  if (status !== "draft" && status !== "ok") return null;
  return { hash, status };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const head = request.method === "HEAD";
    const postId = UNDER_POST.exec(url.pathname)?.[1];
    // /p/<post_id>/ 配下は投稿ごとの CSP、それ以外は何も読めない CSP
    const csp = postId ? cspForPost(url.origin, env.APP_ORIGIN, postId) : CSP_LOCKED;

    if (request.method !== "GET" && !head) {
      const headers = baseHeaders(csp);
      headers.set("allow", "GET, HEAD");
      headers.set("cache-control", "no-store");
      return new Response(null, { status: 405, headers });
    }

    // 配信するのは /p/<post_id>/ ちょうどだけ。末尾スラッシュなし等はリダイレクトせず 404（se#A.4）
    if (!postId || url.pathname !== `/p/${postId}/`) return notFound(csp, head);

    const serve = await readServe(env, postId);
    if (!serve) return notFound(csp, head);
    if (serve.status === "draft") {
      const token = url.searchParams.get("t") ?? "";
      const now = Math.floor(Date.now() / 1000);
      if (!(await verifyPlayToken(env.GAMES_SIGNING_SECRET ?? "", token, postId, now))) {
        return notFound(csp, head);
      }
    }

    const key = `games/${serve.hash}.html`;
    const object = head ? await env.GAMES.head(key) : await env.GAMES.get(key);
    if (!object) return notFound(csp, head);

    const headers = baseHeaders(csp);
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("cache-control", serve.status === "draft" ? "no-store" : "public, max-age=60");
    if (head) return new Response(null, { status: 200, headers });
    // SDK を <head> の先頭に入れて返す（gc#A.4）。HTML は 128 KB 以下（gc#A.2）なので全文を読む
    const html = await (object as R2ObjectBody).text();
    return new Response(injectSdk(html, GUEST_SDK_JS), { status: 200, headers });
  },
};
