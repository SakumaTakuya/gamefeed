/**
 * `GET /api/posts/{id}`（公開済みの投稿を読む。ゲームページが使う）の integration テスト。
 * R-mo.A3-1 の直リンクの部分（moderation.md A.3、mcp.md A.9）。一覧 API はまだ無い。
 * Postgres と Better Auth は本物（ログインは testUtils）、R2 / KV は fake。
 */
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";
import { unpublishGame } from "../../src/my-games.ts";
import { type PostStatus, type PublishDeps, publishGame } from "../../src/publish.ts";
import { gameHtml } from "../helpers/game-html.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので posts の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const NOW = new Date("2026-11-21T03:00:00Z");

dbSuite("GET /api/posts/{id}（mo#A.3、mc#A.9）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let deps: PublishDeps;
  let app: ReturnType<typeof createApp>;
  /** trust_score 30（公開すると public） */
  let me: { id: string; cookie: string };
  /** trust_score 10（公開すると limited） */
  let newbie: { id: string; cookie: string };
  let salt = 0;

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

  interface TestHelpers {
    createUser(u: { email: string; name: string }): { id: string };
    saveUser(u: { id: string }): Promise<unknown>;
    login(o: { userId: string }): Promise<{ cookies: { name: string; value: string }[] }>;
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate table tree_locks, moderation_actions, reports, likes, post_stats, actors, posts, games, users, auth_user cascade`,
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
    app = createApp({ auth, baseURL: BASE, publish: deps });

    const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    async function login(email: string, handle: string, trustScore: number) {
      const user = test.createUser({ email, name: "Taku Sakuma" });
      await test.saveUser(user);
      const { cookies } = await test.login({ userId: user.id });
      await db.insert(s.users).values({ id: user.id, handle, trustScore });
      return { id: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    }
    me = await login("me@example.test", "taku-sakuma", 30);
    newbie = await login("newbie@example.test", "newbie", 10);
  });

  async function post(publish: boolean, userId = me.id, title?: string): Promise<string> {
    const html = gameHtml({ salt: String(++salt), ...(title ? { title } : {}) });
    const r = await publishGame(deps, userId, { html, publish });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value.post_id;
  }
  const get = (id: string, cookie?: string) =>
    app.request(`/api/posts/${id}`, { headers: cookie ? { cookie } : {} });

  async function statusOf(id: string): Promise<PostStatus> {
    const rows = (await db.execute(
      sql`select status from post_status where id = ${id}`,
    )) as unknown as { status: PostStatus }[];
    return rows[0]?.status as PostStatus;
  }

  async function expectNotFound(res: Response): Promise<void> {
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  }

  it("R-mo.A3-1 public の投稿は、ログインなしで題名・作者の handle・公開時刻を返す", async () => {
    const id = await post(true, me.id, "ねこよけ");
    expect(await statusOf(id)).toBe("public");
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      post_id: id,
      title: "ねこよけ",
      author: { handle: "taku-sakuma" },
      published_at: NOW.toISOString(),
    });
  });

  it("R-mo.A3-1 limited の投稿も同じ形で返す（一覧に出ないだけで、直リンクは見える）", async () => {
    const id = await post(true, newbie.id);
    expect(await statusOf(id)).toBe("limited");
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      post_id: id,
      title: "まるタップ",
      author: { handle: "newbie" },
      published_at: NOW.toISOString(),
    });
  });

  it("mc#A.5 応答は auth_user の name・email、users の id・trust_score を含まない", async () => {
    const id = await post(true);
    const text = await (await get(id)).text();
    expect(text).not.toContain(me.id);
    expect(text).not.toMatch(/Taku Sakuma|example\.test|trust|user_id|game_hash|prompt/);
  });

  it("R-mo.A3-1 draft / restricted / unpublished / removed は、匿名・他人・作者のだれが呼んでも同じ not_found", async () => {
    const draft = await post(false);
    const restricted = await post(true);
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, restricted));
    const unpublished = await post(true);
    expect((await unpublishGame(deps, me.id, { post_id: unpublished })).ok).toBe(true);
    const removed = await post(true);
    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, removed));

    const cases: [PostStatus, string][] = [
      ["draft", draft],
      ["restricted", restricted],
      ["unpublished", unpublished],
      ["removed", removed],
    ];
    for (const [status, id] of cases) {
      expect(await statusOf(id)).toBe(status);
      for (const cookie of [undefined, newbie.cookie, me.cookie]) {
        await expectNotFound(await get(id, cookie));
      }
    }
  });

  it("R-mo.A3-1 系譜ごと制限された投稿（tree_locks）も not_found。作者と公開済みの投稿は、だれが呼んでも見える", async () => {
    const locked = await post(true);
    const open = await post(true);
    const [action] = await db
      .insert(s.moderationActions)
      .values({ moderatorId: me.id, kind: "restrict_tree", postId: locked, reason: "test" })
      .returning({ id: s.moderationActions.id });
    await db.insert(s.treeLocks).values({ rootPostId: locked, actionId: action?.id as number });
    expect(await statusOf(locked)).toBe("restricted");
    await expectNotFound(await get(locked));
    for (const cookie of [undefined, newbie.cookie, me.cookie]) {
      expect((await get(open, cookie)).status).toBe(200);
    }
  });

  it("存在しない ID・形式外の ID も同じ not_found", async () => {
    await post(true);
    for (const id of ["01M782MV00TMYMTHTGG5C6KS3T", "nope", "a%20b", "x".repeat(300)]) {
      await expectNotFound(await get(id));
    }
  });

  it("壊れた Cookie が付いていても読める（セッションを引かない）", async () => {
    const id = await post(true);
    expect((await get(id, "better-auth.session_token=garbage")).status).toBe(200);
  });

  it("GET 以外は受けない。試遊トークンの経路は別のまま", async () => {
    const id = await post(true);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await app.request(`/api/posts/${id}`, { method });
      expect([404, 405]).toContain(res.status);
    }
    expect((await app.request(`/api/posts/${id}/play-token`)).status).toBe(401);
  });
});
