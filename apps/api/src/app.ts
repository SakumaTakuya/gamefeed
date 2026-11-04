import { requireMcpAuth } from "@better-auth/mcp";
import { type Context, Hono } from "hono";
import {
  AUTH_BASE_PATH,
  type Auth,
  CONSENT_PAGE,
  createAuth,
  MCP_PATH,
  SIGN_IN_PAGE,
} from "./auth.ts";
import { type ApiConfig, configFromEnv } from "./config.ts";
import { createDb } from "./db/client.ts";
import { createMcpFetchHandler } from "./mcp.ts";
import { consentPage, signInPage } from "./pages.ts";

// REST API・Better Auth・MCP サーバはすべてこの app に載せる。
// Vercel からは /api/index.ts 経由で、ローカルは src/dev.ts から起動する。
//
// ルートの置き場所:
//   /api/health            死活
//   /api/auth/*            Better Auth（Google ログイン、OAuth 2.1 の /oauth2/*、issuer 配下の .well-known）
//   /.well-known/*         RFC 8414 / 9728 のパス挿入形（issuer・リソースにパスがあるので root にも出る）
//   /api/connect/*         ログイン・同意画面（PoC。W5 で SPA へ）
//   /api/mcp               MCP エンドポイント（POST のみ。アクセストークン必須）
// Vercel の rewrite は vercel.json。/.well-known/* も関数に流す必要がある。

export interface AppDeps {
  auth: Auth;
  baseURL: string;
}

export type AppInput = AppDeps | { missing: string[] };

export function createApp(input: AppInput): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true, service: "gamefeed-api" }));

  if ("missing" in input) {
    // 設定不足でも health は生かす（Vercel のプレビュー等）。認証系は理由付きで 503。
    const notConfigured = (c: Context) =>
      c.json({ error: "not_configured", missing: input.missing }, 503);
    for (const path of [`${AUTH_BASE_PATH}/*`, "/.well-known/*", "/api/connect/*", MCP_PATH]) {
      app.all(path, notConfigured);
    }
    return app;
  }

  const { auth, baseURL } = input;
  const authHandler = (req: Request) => auth.handler(req);

  app.all(`${AUTH_BASE_PATH}/*`, (c) => authHandler(c.req.raw));
  app.get("/.well-known/*", (c) => authHandler(c.req.raw));

  app.get(SIGN_IN_PAGE, (c) => c.html(signInPage()));
  app.get(CONSENT_PAGE, (c) => c.html(consentPage()));

  const mcpHandler = createMcpFetchHandler(baseURL);
  const protectedMcp = requireMcpAuth(
    auth,
    (req, claims) =>
      mcpHandler.fetch(req, {
        authInfo: {
          token: req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
          clientId: typeof claims.client_id === "string" ? claims.client_id : "",
          scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
          ...(claims.exp !== undefined ? { expiresAt: claims.exp } : {}),
          extra: { userId: claims.sub },
        },
      }),
    { resource: `${baseURL}${MCP_PATH}` },
  );
  app.post(MCP_PATH, (c) => protectedMcp(c.req.raw));
  // 2025 世代の GET（SSE 再開）/ DELETE（セッション終了）は無状態なので受けない
  app.on(["GET", "DELETE"], MCP_PATH, (c) => c.text("Method not allowed", 405));

  return app;
}

/** 環境変数から app を組む。足りなければ認証系だけ 503 にした app を返す。 */
export function createAppFromEnv(env: Record<string, string | undefined>): Hono {
  const result = configFromEnv(env);
  if (!result.ok) return createApp({ missing: result.missing });
  return createApp(depsFromConfig(result.config));
}

export function depsFromConfig(config: ApiConfig): AppDeps {
  const { db } = createDb(config.databaseUrl);
  const auth = createAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    db,
    google: config.google,
  });
  return { auth, baseURL: config.baseURL };
}

export const app = createAppFromEnv(process.env);

export type App = typeof app;
