import { requireMcpAuth } from "@better-auth/mcp";
import { type Context, Hono } from "hono";
import { DEVICE_ID_HEADER, ensureActor, parseDeviceId } from "./actors.ts";
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
import { createServeKv } from "./kv.ts";
import { createMcpFetchHandler } from "./mcp.ts";
import { consentPage, signInPage } from "./pages.ts";
import { issuePlayToken } from "./play-token.ts";
import type { PublishDeps } from "./publish.ts";
import { createR2Storage } from "./r2.ts";
import { createRun, parseCreateRunInput, type RunError } from "./runs.ts";

// REST API・Better Auth・MCP サーバはすべてこの app に載せる。
// Vercel からは /api/index.ts 経由で、ローカルは src/dev.ts から起動する。
//
// ルートの置き場所:
//   /api/health            死活
//   /api/auth/*            Better Auth（Google ログイン、OAuth 2.1 の /oauth2/*、issuer 配下の .well-known）
//   /.well-known/*         RFC 8414 / 9728 のパス挿入形（issuer・リソースにパスがあるので root にも出る）
//   /api/connect/*         ログイン・同意画面（PoC。W5 で SPA へ）
//   /api/posts/:id/play-token  下書きの試遊トークン（ログイン済みの作者だけ。se#A.5）
//   /api/runs              ランの作成（匿名可。主体は X-Device-Id。run#A.3）
//   /api/mcp               MCP エンドポイント（POST のみ。アクセストークン必須）
// Vercel の rewrite は vercel.json。/.well-known/* も関数に流す必要がある。

export interface AppDeps {
  auth: Auth;
  baseURL: string;
  /** `publish_game` が使うもの（DB・R2・KV・時計）。R2 / KV が無ければツールは `not_configured` を返す（mc#A.2） */
  publish: PublishDeps;
  /** 試遊トークンの署名鍵（se#A.5）。配信 Worker と同じ値。無ければ play-token は `not_configured` */
  gamesSigningSecret?: string;
  /** [0, 1) の乱数。山札の抽選に使う（run#A.10）。既定は Math.random。テストは seed から決まるものを渡す */
  random?: () => number;
}

const RUN_ERROR_STATUS = {
  invalid_request: 400,
  run_not_found: 404,
  no_games: 409,
} as const satisfies Record<RunError, number>;

export type AppInput = AppDeps | { missing: string[] };

export function createApp(input: AppInput): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true, service: "gamefeed-api" }));

  if ("missing" in input) {
    // 設定不足でも health は生かす（Vercel のプレビュー等）。認証系は理由付きで 503。
    const notConfigured = (c: Context) =>
      c.json({ error: "not_configured", missing: input.missing }, 503);
    for (const path of [
      `${AUTH_BASE_PATH}/*`,
      "/.well-known/*",
      "/api/connect/*",
      "/api/posts/*",
      "/api/runs",
      "/api/runs/*",
      MCP_PATH,
    ]) {
      app.all(path, notConfigured);
    }
    return app;
  }

  const { auth, baseURL, publish, gamesSigningSecret } = input;
  const random = input.random ?? Math.random;
  const authHandler = (req: Request) => auth.handler(req);

  app.all(`${AUTH_BASE_PATH}/*`, (c) => authHandler(c.req.raw));
  app.get("/.well-known/*", (c) => authHandler(c.req.raw));

  app.get(SIGN_IN_PAGE, (c) => c.html(signInPage()));
  app.get(CONSENT_PAGE, (c) => c.html(consentPage()));

  // 下書きの試遊トークン（se#A.5）。作者本人の draft 以外は理由を区別せず not_found
  app.get("/api/posts/:id/play-token", async (c) => {
    c.header("cache-control", "no-store");
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (!gamesSigningSecret) {
      return c.json({ error: "not_configured", missing: ["GAMES_SIGNING_SECRET"] }, 503);
    }
    const token = await issuePlayToken(
      { db: publish.db, now: publish.now, secret: gamesSigningSecret },
      session.user.id,
      c.req.param("id"),
    );
    return token ? c.json(token) : c.json({ error: "not_found" }, 404);
  });

  // ランの作成（run#A.3）。匿名で呼べる。主体は X-Device-Id から upsert する（dm#A.3、#141）
  app.post("/api/runs", async (c) => {
    c.header("cache-control", "no-store");
    const deviceId = parseDeviceId(c.req.header(DEVICE_ID_HEADER));
    if (!deviceId) return c.json({ error: "invalid_device" }, 400);
    const input = parseCreateRunInput(await c.req.json().catch(() => null));
    if (!input) return c.json({ error: "invalid_request" }, RUN_ERROR_STATUS.invalid_request);
    // ログイン中なら主体に user_id を結ぶ。Cookie が無ければセッションを引かない
    const session = c.req.header("cookie")
      ? await auth.api.getSession({ headers: c.req.raw.headers })
      : null;
    const deps = { db: publish.db, now: publish.now, random };
    const actor = await ensureActor(deps, deviceId, session?.user.id);
    const result = await createRun(deps, actor.id, input);
    return result.ok
      ? c.json(result.value, 201)
      : c.json({ error: result.error }, RUN_ERROR_STATUS[result.error]);
  });

  const mcpHandler = createMcpFetchHandler(publish);
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
  // SPA と API は同じ Vercel プロジェクトなので、試遊 URL・ゲームページの元（mc#A.9）は baseURL と同じ。
  // R2_* / KV の変数が揃っていなければ storage / kv は入らず、publish_game は not_configured を返す（mc#A.2）
  const publish: PublishDeps = {
    db,
    appOrigin: config.baseURL,
    now: () => new Date(),
    ...(config.r2 ? { storage: createR2Storage(config.r2) } : {}),
    ...(config.kv ? { kv: createServeKv(config.kv) } : {}),
    storageMissing: config.storageMissing,
  };
  return {
    auth,
    baseURL: config.baseURL,
    publish,
    ...(config.gamesSigningSecret ? { gamesSigningSecret: config.gamesSigningSecret } : {}),
  };
}

export const app = createAppFromEnv(process.env);

export type App = typeof app;
