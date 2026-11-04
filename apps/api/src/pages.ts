/**
 * OAuth 認可フロー中の画面（ログイン・同意）。#5 の PoC では API が最小の HTML を返す。
 * W5（plan#9）で SPA（apps/web）に移す。ここに載せるのは Better Auth の約束事だけ:
 *
 * - ログイン: `/api/auth/oauth2/authorize` が未ログインなら `loginPage?<署名付き oauth_query>` に飛ばす。
 *   画面は `POST /api/auth/sign-in/social` に `{ provider: "google", oauth_query }` を送る。
 *   Google から戻ってセッションができると、Better Auth が認可を自動で続ける。
 * - 同意: `consentPage?client_id&scope&…` に飛んでくる。画面は `POST /api/auth/oauth2/consent` に
 *   `{ accept: true, oauth_query }` を送り、返ってきた URL（redirect_uri?code=…）へ移動する。
 */

import { AUTH_BASE_PATH } from "./auth.ts";

const style = `
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.6; }
  button { font: inherit; padding: .6rem 1.2rem; border-radius: .5rem; border: 1px solid #888; cursor: pointer; }
  code { background: #eee; padding: 0 .3em; border-radius: .25em; }
  .error { color: #b00020; }
`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${style}</style></head>
<body>${body}
<p id="status" class="error"></p>
<script>
const AUTH = ${JSON.stringify(AUTH_BASE_PATH)};
const oauthQuery = location.search.replace(/^\\?/, "");
const status = document.getElementById("status");
async function post(path, body) {
  const res = await fetch(AUTH + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.message || data.error || ("HTTP " + res.status));
  return data;
}
${script}
</script></body></html>`;
}

export function signInPage(): string {
  return page(
    "GameFeed にログイン",
    `<h1>GameFeed</h1>
     <p>AI クライアントが GameFeed に投稿するために、あなたの Google アカウントでログインします。</p>
     <p><button id="google">Google でログイン</button></p>`,
    `document.getElementById("google").onclick = async () => {
      try {
        const data = await post("/sign-in/social", { provider: "google", oauth_query: oauthQuery, callbackURL: "/" });
        if (data.url) location.href = data.url; else status.textContent = "応答に url がありません";
      } catch (e) { status.textContent = String(e.message || e); }
    };`,
  );
}

export function consentPage(): string {
  return page(
    "GameFeed への接続を許可",
    `<h1>接続を許可しますか？</h1>
     <p>クライアント <code id="client"></code> が、あなたの GameFeed アカウントで
     ゲームの投稿・一覧・取り下げを行うことを求めています。</p>
     <p>スコープ: <code id="scope"></code></p>
     <p><button id="accept">許可する</button> <button id="deny">許可しない</button></p>`,
    `const q = new URLSearchParams(location.search);
    document.getElementById("client").textContent = q.get("client_id") || "";
    document.getElementById("scope").textContent = q.get("scope") || "";
    async function consent(accept) {
      try {
        const data = await post("/oauth2/consent", { accept, oauth_query: oauthQuery });
        const url = data.url || data.redirectURI || data.redirect_uri;
        if (url) location.href = url; else status.textContent = "応答に url がありません: " + JSON.stringify(data);
      } catch (e) { status.textContent = String(e.message || e); }
    }
    document.getElementById("accept").onclick = () => consent(true);
    document.getElementById("deny").onclick = () => consent(false);`,
  );
}
