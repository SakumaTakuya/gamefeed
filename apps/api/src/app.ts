import { requireMcpAuth } from "@better-auth/mcp";
import { parseReportInput } from "@gamefeed/domain";
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
import { type ApiConfig, configFromEnv, KV_VARS } from "./config.ts";
import { createDb } from "./db/client.ts";
import { finishRun } from "./finish.ts";
import { createServeKv } from "./kv.ts";
import { likePost } from "./likes.ts";
import { createMcpFetchHandler } from "./mcp.ts";
import { parseModerationReason, restorePost } from "./moderation.ts";
import { consentPage, signInPage } from "./pages.ts";
import { issuePlayToken } from "./play-token.ts";
import { readPublicPost } from "./post-read.ts";
import type { PublishDeps } from "./publish.ts";
import { createR2Storage } from "./r2.ts";
import { reportPost } from "./reports.ts";
import { createRun, parseCreateRunInput, type RunError } from "./runs.ts";
import { deviceKindOf, parseTurn, type ReplayStorage, settleTurn } from "./turns.ts";

// REST API・Better Auth・MCP サーバはすべてこの app に載せる。
// Vercel からは /api/index.ts 経由で、ローカルは src/dev.ts から起動する。
//
// ルートの置き場所:
//   /api/health            死活
//   /api/auth/*            Better Auth（Google ログイン、OAuth 2.1 の /oauth2/*、issuer 配下の .well-known）
//   /.well-known/*         RFC 8414 / 9728 のパス挿入形（issuer・リソースにパスがあるので root にも出る）
//   /api/connect/*         ログイン・同意画面（PoC。W5 で SPA へ）
//   /api/posts/:id             公開済みの投稿を読む（匿名可。limited / public だけ。mo#A.3）
//   /api/posts/:id/like        いいね（PUT。匿名可、X-Device-Id。冪等）
//   /api/posts/:id/reports     通報の受付（POST。匿名可、X-Device-Id。mo#A.4）
//   /api/posts/:id/play-token  下書きの試遊トークン（ログイン済みの作者だけ。se#A.5）
//   /api/moderation/posts/:id/restore  運営の復帰（POST。MODERATOR_IDS のユーザーだけ。mo#A.7、se#A.8）
//   /api/runs              ランの作成（匿名可。主体は X-Device-Id。run#A.3）
//   /api/runs/:id/turns/:t 手番 t の結果を記録に足す（そのランの主体だけ。run#A.3、sc#A.2）
//   /api/runs/:id/finish   ランを閉じて成績表を凍結する（そのランの主体だけ。run#A.3、sc#A.9）
//   /api/mcp               MCP エンドポイント（POST のみ。アクセストークン必須）
// Vercel の rewrite は vercel.json。/.well-known/* も関数に流す必要がある。

export interface AppDeps {
  auth: Auth;
  baseURL: string;
  /** `publish_game` が使うもの（DB・R2・KV・時計）。R2 / KV が無ければツールは `not_configured` を返す（mc#A.2） */
  publish: PublishDeps;
  /** 試遊トークンの署名鍵（se#A.5）。配信 Worker と同じ値。無ければ play-token は `not_configured` */
  gamesSigningSecret?: string;
  /** 入力ログの置き場（R2）。無ければ結果は受理するが入力ログは保存しない（dm#A.6） */
  replays?: ReplayStorage;
  /** 運営の `users.id`（se#A.8 の `MODERATOR_IDS`）。無い・空なら運営の操作は誰も呼べない */
  moderatorIds?: readonly string[];
  /** [0, 1) の乱数。山札の抽選（run#A.10）とランの seed に使う。既定は Math.random。テストは seed から決まるものを渡す */
  random?: () => number;
}

const RUN_ERROR_STATUS = {
  invalid_request: 400,
  run_not_found: 404,
  no_games: 409,
} as const satisfies Record<RunError, number>;

const RESTORE_ERROR_STATUS = {
  forbidden: 403,
  not_found: 404,
  invalid_state: 409,
} as const;

const TURN_ERROR_STATUS = {
  run_not_found: 404,
  invalid_request: 400,
  out_of_order: 409,
  run_closed: 409,
  invalid_result: 422,
} as const;

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
      "/api/moderation/*",
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
  const moderatorIds = new Set(input.moderatorIds ?? []);
  const authHandler = (req: Request) => auth.handler(req);

  app.all(`${AUTH_BASE_PATH}/*`, (c) => authHandler(c.req.raw));
  app.get("/.well-known/*", (c) => authHandler(c.req.raw));

  app.get(SIGN_IN_PAGE, (c) => c.html(signInPage()));
  app.get(CONSENT_PAGE, (c) => c.html(consentPage()));

  // 公開済みの投稿を読む（ゲームページ。mo#A.3、mc#A.9）。匿名で呼べ、セッションを引かない。
  // limited / public 以外は、存在しない ID も含めて理由を区別せず not_found
  app.get("/api/posts/:id", async (c) => {
    c.header("cache-control", "no-store");
    // X-Device-Id があれば、その端末がいいね済みかを返す。無い・形式外でも読める
    const deviceId = parseDeviceId(c.req.header(DEVICE_ID_HEADER));
    const post = await readPublicPost(publish.db, c.req.param("id"), deviceId);
    return post ? c.json(post) : c.json({ error: "not_found" }, 404);
  });

  // いいね（product#3 の 5、I14）。匿名で呼べる。主体は X-Device-Id から upsert する。冪等
  app.put("/api/posts/:id/like", async (c) => {
    c.header("cache-control", "no-store");
    const deviceId = parseDeviceId(c.req.header(DEVICE_ID_HEADER));
    if (!deviceId) return c.json({ error: "invalid_device" }, 400);
    // ログイン中なら主体に user_id を結ぶ。Cookie が無ければセッションを引かない
    const session = c.req.header("cookie")
      ? await auth.api.getSession({ headers: c.req.raw.headers })
      : null;
    const ok = await likePost(
      { db: publish.db, now: publish.now },
      { postId: c.req.param("id"), deviceId, userId: session?.user.id ?? null },
    );
    return ok ? c.json({ liked: true }) : c.json({ error: "not_found" }, 404);
  });

  // 通報の受付（mo#A.4）。匿名で呼べる。主体は X-Device-Id から upsert する。2 回目は何もせず成功
  app.post("/api/posts/:id/reports", async (c) => {
    c.header("cache-control", "no-store");
    // 通報は自動制限を起こす（mo#A.4）。KV に書けない構成では制限が配信に届かないので、受け付けない
    const kv = publish.kv;
    if (!kv) return c.json({ error: "not_configured", missing: [...KV_VARS] }, 503);
    const deviceId = parseDeviceId(c.req.header(DEVICE_ID_HEADER));
    if (!deviceId) return c.json({ error: "invalid_device" }, 400);
    const report = parseReportInput(await c.req.json().catch(() => null));
    if (!report) return c.json({ error: "invalid_request" }, 400);
    // ログイン中なら主体に user_id を結ぶ（重みと、作者自身の検査に使う）
    const session = c.req.header("cookie")
      ? await auth.api.getSession({ headers: c.req.raw.headers })
      : null;
    const outcome = await reportPost(
      { db: publish.db, now: publish.now, kv },
      { postId: c.req.param("id"), deviceId, userId: session?.user.id ?? null, report },
    );
    if (outcome === "not_found") return c.json({ error: "not_found" }, 404);
    if (outcome === "invalid") return c.json({ error: "invalid" }, 400);
    return c.json({ reported: true });
  });

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

  // 運営の復帰（mo#A.7 の restore）。se#A.8: MODERATOR_IDS に含まれるユーザーだけが呼べる。
  // 権限の無い人には、投稿があるかどうかも本文の形も答えない（先に forbidden）
  app.post("/api/moderation/posts/:id/restore", async (c) => {
    c.header("cache-control", "no-store");
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (!moderatorIds.has(session.user.id)) return c.json({ error: "forbidden" }, 403);
    // 復帰は配信を戻す（se#A.5）。KV に書けない構成では DB だけ戻って配信が止まったままになるので、受け付けない
    const kv = publish.kv;
    if (!kv) return c.json({ error: "not_configured", missing: [...KV_VARS] }, 503);
    const reason = parseModerationReason(await c.req.json().catch(() => null));
    if (!reason) return c.json({ error: "invalid_request" }, 400);
    const result = await restorePost(
      { db: publish.db, now: publish.now, kv },
      { postId: c.req.param("id"), moderatorId: session.user.id, reason },
    );
    return result.ok
      ? c.json(result.value)
      : c.json({ error: result.error }, RESTORE_ERROR_STATUS[result.error]);
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

  // 手番 t の結果を記録に足す（run#A.3、sc#A.2）。ランを作った主体だけが送れる。
  // 本文は記録の次の手番のときにだけ読む（記録にある手番は本文を見ずに同じ内容を返す）
  app.put("/api/runs/:id/turns/:t", async (c) => {
    c.header("cache-control", "no-store");
    const deviceId = parseDeviceId(c.req.header(DEVICE_ID_HEADER));
    if (!deviceId) return c.json({ error: "invalid_device" }, 400);
    const turn = parseTurn(c.req.param("t"));
    if (turn === null) return c.json({ error: "invalid_request" }, 400);
    const body: unknown = await c.req.json().catch(() => undefined);
    // ログイン中なら主体に user_id を結ぶ（作者本人の結果を分布に入れないため。sc#A.4）
    const session = c.req.header("cookie")
      ? await auth.api.getSession({ headers: c.req.raw.headers })
      : null;
    const deps = {
      db: publish.db,
      now: publish.now,
      ...(input.replays ? { replays: input.replays } : {}),
    };
    const actor = await ensureActor(deps, deviceId, session?.user.id);
    const result = await settleTurn(deps, {
      runId: c.req.param("id"),
      turn,
      actor,
      deviceKind: deviceKindOf(c.req.header("user-agent")),
      body,
    });
    if (result.ok) return c.json(result.value);
    const status = TURN_ERROR_STATUS[result.error];
    if (result.error === "invalid_result") {
      return c.json({ error: result.error, reason: result.reason }, status);
    }
    if (result.error === "out_of_order" || result.error === "run_closed") {
      return c.json({ error: result.error, settled: result.settled }, status);
    }
    return c.json({ error: result.error }, status);
  });

  // ランを閉じる（run#A.3）。凍結した成績表を返す。2 回目以降も同じ値
  app.post("/api/runs/:id/finish", async (c) => {
    c.header("cache-control", "no-store");
    const deviceId = parseDeviceId(c.req.header(DEVICE_ID_HEADER));
    if (!deviceId) return c.json({ error: "invalid_device" }, 400);
    const deps = { db: publish.db, now: publish.now };
    const actor = await ensureActor(deps, deviceId);
    const result = await finishRun(deps, { runId: c.req.param("id"), actorId: actor.id });
    return result.ok
      ? c.json(result.value)
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
  const storage = config.r2 ? createR2Storage(config.r2) : undefined;
  const publish: PublishDeps = {
    db,
    appOrigin: config.baseURL,
    now: () => new Date(),
    ...(storage ? { storage } : {}),
    ...(config.kv ? { kv: createServeKv(config.kv) } : {}),
    storageMissing: config.storageMissing,
  };
  return {
    auth,
    baseURL: config.baseURL,
    publish,
    ...(storage ? { replays: storage } : {}),
    ...(config.gamesSigningSecret ? { gamesSigningSecret: config.gamesSigningSecret } : {}),
    moderatorIds: config.moderatorIds,
  };
}

export const app = createAppFromEnv(process.env);

export type App = typeof app;
