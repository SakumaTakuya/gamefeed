/**
 * R-9-1: OAuth 2.1 の DCR・PKCE・`.well-known` を提供し、MCP 公式 SDK のクライアントで
 * DCR → 認可 → 同意 → トークン → `tools/list` → `publish_game`（ダミー）まで通る（spec#9、plan#9、#5）。
 *
 * 本物を使う範囲（docs/testing.md）: Postgres、Better Auth、@better-auth/mcp、MCP SDK v2 のクライアントは
 * すべて本物で、実際の HTTP（@hono/node-server、空きポート）を通す。差し替えるのは「人がブラウザで
 * ログイン・同意する」部分だけ: Google ログインの代わりに Better Auth の testUtils でセッションを作り、
 * 認可 URL → 同意画面 → `/oauth2/consent` をそのセッションの Cookie で辿る。
 */

import { type ServerType, serve } from "@hono/node-server";
import {
  Client,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import {
  ACCESS_TOKEN_EXPIRES_IN,
  AUTH_BASE_PATH,
  CONSENT_PAGE,
  createAuth,
  MCP_PATH,
  SIGN_IN_PAGE,
} from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn(
    "DATABASE_URL が未設定なので MCP OAuth の integration テストを skip します（CI では必ず設定する）",
  );
}
const dbSuite = url ? describe : describe.skip;

/** MCP クライアント側の OAuth 状態（メモリ）。「ブラウザでの認可」は browse() が肩代わりする。 */
class TestOAuthProvider implements OAuthClientProvider {
  info: OAuthClientInformationFull | undefined;
  savedTokens: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;
  readonly redirectUrl = "http://127.0.0.1:43110/callback";
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "gamefeed-integration-test",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationFull) {
    this.info = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.savedTokens = tokens;
  }
  redirectToAuthorization(authorizationUrl: URL) {
    this.authorizationUrl = authorizationUrl;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  discovery: OAuthDiscoveryState | undefined;
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
}

dbSuite("R-9-1 MCP OAuth 2.1（DCR・PKCE・.well-known）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let server: ServerType;
  let baseURL: string;
  let auth: ReturnType<typeof createAuth>;
  /** ログイン済みブラウザのふりをするための Cookie ヘッダ */
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    const h = createDb(url as string, { max: 1 });
    db = h.db;
    close = h.close;
    await resetDb(db);
    await migrateDb(db);

    // 先にポートを確保してから baseURL を決める（issuer と resource に入るため）
    let fetchImpl: (req: Request) => Promise<Response> = async () =>
      new Response("not ready", { status: 503 });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: (req) => fetchImpl(req), port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve(info.port),
      );
    });
    baseURL = `http://127.0.0.1:${port}`;

    auth = createAuth({
      baseURL,
      secret: "test-secret-".repeat(4),
      db,
      extraPlugins: [testUtils()],
    });
    const app = createApp({ auth, baseURL });
    fetchImpl = async (req) => app.fetch(req);

    // Google ログインの代わり: 本物の Better Auth で user と session を作る
    const ctx = await auth.$context;
    const test = (
      ctx as unknown as {
        test: ReturnType<typeof testUtils>["init"] extends (...a: never[]) => infer R
          ? R extends { context: { test: infer T } }
            ? T
            : never
          : never;
      }
    ).test;
    const user = test.createUser({ email: "poc@example.test", name: "PoC" });
    await test.saveUser(user);
    const login = await test.login({ userId: user.id });
    userId = user.id;
    cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await close?.();
  });

  /**
   * 「ログイン済みのブラウザ」が認可 URL を開いてから redirect_uri に戻るまでを辿り、code を返す。
   * 認可 → （未ログインならログイン画面）→ 同意画面 → /oauth2/consent → redirect_uri?code=…
   */
  async function browse(authorizationUrl: URL): Promise<URLSearchParams> {
    let current = authorizationUrl.toString();
    for (let hop = 0; hop < 8; hop++) {
      // Node の fetch は sec-fetch-mode: cors を付けるので、ブラウザのナビゲーションであることを明示する
      const res = await fetch(current, {
        headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
        redirect: "manual",
      });
      let location = res.headers.get("location");
      if (res.status === 200 && res.headers.get("content-type")?.includes("application/json")) {
        // API 呼び出しと判定された場合は { redirect: true, url } が返る
        const body = (await res.json()) as { redirect?: boolean; url?: string };
        if (body.redirect && body.url) location = body.url;
      }
      if (location) {
        const next = new URL(location, current);
        if (next.pathname === "/callback") return next.searchParams;
        if (next.pathname === SIGN_IN_PAGE)
          throw new Error(`ログイン画面に飛ばされた（セッション Cookie が効いていない）: ${next}`);
        if (next.pathname === CONSENT_PAGE) {
          // 同意画面の JS がやること（pages.ts）をそのまま行う
          const consent = await fetch(`${baseURL}${AUTH_BASE_PATH}/oauth2/consent`, {
            method: "POST",
            headers: {
              cookie,
              "content-type": "application/json",
              accept: "application/json",
              origin: baseURL,
            },
            body: JSON.stringify({ accept: true, oauth_query: next.search.slice(1) }),
          });
          const body = (await consent.json()) as Record<string, unknown>;
          expect(consent.status, JSON.stringify(body)).toBe(200);
          const redirectTo = String(body.url ?? body.redirectURI ?? body.redirect_uri ?? "");
          expect(redirectTo).toContain("/callback");
          return new URL(redirectTo).searchParams;
        }
        current = next.toString();
        continue;
      }
      throw new Error(
        `予期しない応答 ${res.status} at ${current}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    throw new Error("リダイレクトが多すぎる");
  }

  async function connectWithOAuth(provider: TestOAuthProvider): Promise<Client> {
    const client = new Client({ name: "gamefeed-test-client", version: "0.0.0" });
    const endpoint = new URL(`${baseURL}${MCP_PATH}`);
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
      return client; // 既にトークンがある場合
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
    }
    expect(provider.authorizationUrl, "redirectToAuthorization が呼ばれる").toBeDefined();
    const params = await browse(provider.authorizationUrl as URL);
    expect(params.get("code")).toBeTruthy();
    expect(params.get("iss"), "RFC 9207 iss").toBe(`${baseURL}${AUTH_BASE_PATH}`);
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
    await transport.finishAuth(params);
    await client.connect(transport);
    return client;
  }

  it(".well-known の認可サーバメタデータが issuer 配下とパス挿入形の両方で取れ、DCR と PKCE S256 を広告する", async () => {
    const issuer = `${baseURL}${AUTH_BASE_PATH}`;
    for (const u of [
      `${issuer}/.well-known/oauth-authorization-server`,
      `${baseURL}/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`,
    ]) {
      const res = await fetch(u);
      expect(res.status, u).toBe(200);
      const meta = (await res.json()) as Record<string, unknown>;
      expect(meta.issuer).toBe(issuer);
      expect(meta.registration_endpoint).toBe(`${issuer}/oauth2/register`);
      expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
      expect(meta.grant_types_supported).toContain("refresh_token");
    }
  });

  it("保護リソースメタデータ（RFC 9728）が /api/mcp を resource とし、認可サーバを指す", async () => {
    const res = await fetch(`${baseURL}/.well-known/oauth-protected-resource${MCP_PATH}`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.resource).toBe(`${baseURL}${MCP_PATH}`);
    expect(meta.authorization_servers).toEqual([`${baseURL}${AUTH_BASE_PATH}`]);
  });

  it("トークンなしの POST /api/mcp は 401 と WWW-Authenticate（resource_metadata 付き）を返す", async () => {
    const res = await fetch(`${baseURL}${MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(
      /resource_metadata="[^"]+oauth-protected-resource/,
    );
  });

  it("公式 SDK クライアントで DCR → 認可 → 同意 → トークン → tools/list → publish_game（ダミー）が通る", async () => {
    const provider = new TestOAuthProvider();
    const client = await connectWithOAuth(provider);

    // DCR で登録された
    expect(provider.info?.client_id).toBeTruthy();
    // トークン方針（計画書 第5節）: 24h 以上、リフレッシュトークンあり
    expect(provider.savedTokens?.access_token).toBeTruthy();
    expect(provider.savedTokens?.refresh_token).toBeTruthy();
    expect(provider.savedTokens?.expires_in).toBeGreaterThanOrEqual(ACCESS_TOKEN_EXPIRES_IN - 5);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["publish_game"]);

    const result = await client.callTool({
      name: "publish_game",
      arguments: { html: "<!doctype html><title>PoC</title>", title: "PoC", prompt: "接続確認" },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.post_id).toMatch(/^gf:poc-/);
    expect(structured.user_id).toBe(userId);
    expect(structured.missing_assets).toEqual([]);
    await client.close();
  }, 30_000);

  it("2 度目の接続は同意済みなので同意画面を経ずにトークンが出る（保存したトークンで直接つながる）", async () => {
    const provider = new TestOAuthProvider();
    const first = await connectWithOAuth(provider);
    await first.close();
    // 同じクライアント情報とトークンを持つ 2 つ目の接続はそのまま通る
    const again = new Client({ name: "gamefeed-test-client", version: "0.0.0" });
    await again.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}${MCP_PATH}`), {
        authProvider: provider,
      }),
    );
    expect((await again.listTools()).tools).toHaveLength(1);
    await again.close();
  }, 30_000);

  it("リフレッシュトークンはローテーションし、猶予内なら旧トークンでも同じ応答が返る（401 にならない）", async () => {
    const provider = new TestOAuthProvider();
    const client = await connectWithOAuth(provider);
    await client.close();
    const clientId = provider.info?.client_id as string;
    const oldRefresh = provider.savedTokens?.refresh_token as string;

    const refresh = () =>
      fetch(`${baseURL}${AUTH_BASE_PATH}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: oldRefresh,
          client_id: clientId,
        }),
      });
    const r1 = await refresh();
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as Record<string, unknown>;
    expect(t1.refresh_token).toBeTruthy();
    expect(t1.refresh_token).not.toBe(oldRefresh);

    // 同じ旧トークンでの再試行（コールドスタート中の再送を模す）
    const r2 = await refresh();
    expect(r2.status).toBe(200);
    const t2 = (await r2.json()) as Record<string, unknown>;
    expect(t2.refresh_token).toBe(t1.refresh_token);
    expect(t2.access_token).toBe(t1.access_token);
  }, 30_000);
});
