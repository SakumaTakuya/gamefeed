/**
 * `GET /api/posts/{id}/play-token`（security.md A.5）の integration テスト。R-se.A5-2 の API 側。
 * Postgres と Better Auth は本物（ログインは testUtils）、R2 / KV は fake。
 */
import { createHmac } from "node:crypto";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";
import { unpublishGame } from "../../src/my-games.ts";
import { PLAY_TOKEN_TTL_SEC, signPlayToken } from "../../src/play-token.ts";
import { type PublishDeps, publishGame } from "../../src/publish.ts";
import { gameHtml } from "../helpers/game-html.ts";

const url = process.env.DATABASE_URL;
if (!url)
  console.warn("DATABASE_URL が未設定なので play-token の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const SECRET = "games-signing-secret-for-tests-0123456789";
const NOW = new Date("2026-11-13T03:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
/** post_id 01M782MV00TMYMTHTGG5C6KS3T、exp 4102444800（2100-01-01）、秘密 "test-signing-secret"。apps/games/test/integration/serve.spec.ts と同じ値 */
const FIXED_TOKEN =
  "MDFNNzgyTVYwMFRNWU1USFRHRzVDNktTM1QuNDEwMjQ0NDgwMA.vIJI1mUrXnptV_vUHRHtfluI0pWzZhgVA8j8-aPSAEg";

describe("試遊トークンの形（se#A.5）", () => {
  it("base64url(post_id.exp) + . + base64url(HMAC-SHA256(secret, post_id.exp))。Worker のテストと同じ固定値", () => {
    const token = signPlayToken("test-signing-secret", "01M782MV00TMYMTHTGG5C6KS3T", 4102444800);
    const payload = "01M782MV00TMYMTHTGG5C6KS3T.4102444800";
    const expected = `${Buffer.from(payload).toString("base64url")}.${createHmac("sha256", "test-signing-secret").update(payload).digest("base64url")}`;
    expect(token).toBe(expected);
    expect(token).toBe(FIXED_TOKEN);
    expect(PLAY_TOKEN_TTL_SEC).toBe(600);
  });
});

dbSuite("GET /api/posts/{id}/play-token（se#A.5）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let deps: PublishDeps;
  let app: ReturnType<typeof createApp>;
  let me: { id: string; cookie: string };
  let other: { id: string; cookie: string };

  beforeAll(async () => {
    const h = createDb(url as string, { max: 1 });
    db = h.db;
    close = h.close;
    await resetDb(db);
    await migrateDb(db);
  }, 60_000);

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table reports, likes, post_stats, actors, posts, games, users, auth_user cascade`,
    );
    const auth = createAuth({
      baseURL: BASE,
      secret: "test-secret-".repeat(4),
      db,
      extraPlugins: [testUtils()],
    });
    deps = {
      db,
      storage: { put: async () => {} },
      kv: { put: async () => {} },
      appOrigin: BASE,
      now: () => NOW,
    };
    app = createApp({ auth, baseURL: BASE, publish: deps, gamesSigningSecret: SECRET });

    const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    async function login(email: string) {
      const user = test.createUser({ email, name: "Taku Sakuma" });
      await test.saveUser(user);
      const { cookies } = await test.login({ userId: user.id });
      await db
        .insert(s.users)
        .values({ id: user.id, handle: email.split("@")[0] ?? "h", trustScore: 30 });
      return { id: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    }
    me = await login("me@example.test");
    other = await login("other@example.test");
  });

  interface TestHelpers {
    createUser(u: { email: string; name: string }): { id: string };
    saveUser(u: { id: string }): Promise<unknown>;
    login(o: { userId: string }): Promise<{ cookies: { name: string; value: string }[] }>;
  }

  async function post(publish: boolean, userId = me.id, salt = "a"): Promise<string> {
    const r = await publishGame(deps, userId, { html: gameHtml({ salt }), publish });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value.post_id;
  }
  const get = (id: string, cookie?: string) =>
    app.request(`/api/posts/${id}/play-token`, { headers: cookie ? { cookie } : {} });

  async function expectNotFound(res: Response): Promise<void> {
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  }

  it("R-se.A5-2: draft の作者には、10 分後に切れるトークンを返す", async () => {
    const id = await post(false);
    const res = await get(id, me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const exp = NOW_SEC + 600;
    expect(await res.json()).toEqual({ token: signPlayToken(SECRET, id, exp), exp });
  });

  it("R-se.A5-2: 他人の draft は not_found", async () => {
    const id = await post(false);
    await expectNotFound(await get(id, other.cookie));
  });

  it("R-se.A5-2: 公開済み・非公開にした投稿は、作者でも not_found", async () => {
    const pub = await post(true);
    await expectNotFound(await get(pub, me.cookie));
    const r = await unpublishGame(deps, me.id, { post_id: pub });
    expect(r.ok).toBe(true);
    await expectNotFound(await get(pub, me.cookie));
  });

  it("存在しない ID・形式外の ID も同じ not_found", async () => {
    await post(false);
    for (const id of ["01M782MV00TMYMTHTGG5C6KS3T", "nope", "a%20b", "x".repeat(300)]) {
      await expectNotFound(await get(id, me.cookie));
    }
  });

  it("users 行がまだないログイン済みユーザーは not_found（行を作らない）", async () => {
    const id = await post(false);
    await db.execute(sql`delete from users where id = ${other.id}`);
    await expectNotFound(await get(id, other.cookie));
    expect(await db.select().from(s.users).where(eq(s.users.id, other.id))).toHaveLength(0);
  });

  it("未ログインは 401（投稿の有無にかかわらず同じ応答）", async () => {
    const id = await post(false);
    for (const target of [id, "01M782MV00TMYMTHTGG5C6KS3T"]) {
      const res = await get(target);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const bad = await get(id, "better-auth.session_token=garbage");
    expect(bad.status).toBe(401);
  });

  it("GAMES_SIGNING_SECRET が無ければ 503 not_configured（変数名だけを返す）", async () => {
    const auth = createAuth({ baseURL: BASE, secret: "test-secret-".repeat(4), db });
    const bare = createApp({ auth, baseURL: BASE, publish: deps });
    const res = await bare.request(`/api/posts/${await post(false)}/play-token`, {
      headers: { cookie: me.cookie },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "not_configured",
      missing: ["GAMES_SIGNING_SECRET"],
    });
  });

  it("GET 以外は受けない", async () => {
    const id = await post(false);
    const res = await app.request(`/api/posts/${id}/play-token`, {
      method: "POST",
      headers: { cookie: me.cookie },
    });
    expect([404, 405]).toContain(res.status);
  });
});
