/**
 * 通報の受付 `POST /api/posts/{id}/reports` の integration テスト（moderation.md A.4。R-mo.A4-1、A4-2）。
 * 自動制限（R-mo.A4-3）はまだ無い。Postgres と Better Auth は本物（ログインは testUtils）、R2 / KV は fake。
 */
import { REPORT_COEF, REPORT_COMMENT_MAX } from "@gamefeed/domain";
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
if (!url) console.warn("DATABASE_URL が未設定なので reports の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const NOW = new Date("2026-11-21T03:00:00Z");
const DEVICE_A = "AAAAAAAAAAAAAAAAAAAAAA";
const DEVICE_B = "BBBBBBBBBBBBBBBBBBBBBB";
const DEVICE_C = "CCCCCCCCCCCCCCCCCCCCCC";

dbSuite("POST /api/posts/{id}/reports（mo#A.4）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let deps: PublishDeps;
  let app: ReturnType<typeof createApp>;
  /** 作者。trust_score 30 */
  let author: { id: string; cookie: string };
  /** 通報者。trust_score 10（新規。信頼係数 1.0） */
  let newbie: { id: string; cookie: string };
  /** 通報者。trust_score 50（信頼係数 5.0） */
  let trusted: { id: string; cookie: string };
  /** ログインはしているが users 行が無い（遊ぶだけの人） */
  let player: { id: string; cookie: string };
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
    async function login(name: string, trustScore: number | null) {
      const user = test.createUser({ email: `${name}@example.test`, name });
      await test.saveUser(user);
      const { cookies } = await test.login({ userId: user.id });
      if (trustScore !== null)
        await db.insert(s.users).values({ id: user.id, handle: name, trustScore });
      return { id: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    }
    author = await login("author", 30);
    newbie = await login("newbie", 10);
    trusted = await login("trusted", 50);
    player = await login("player", null);
  });

  async function post(publish = true, userId = author.id): Promise<string> {
    const r = await publishGame(deps, userId, {
      html: gameHtml({ salt: String(++salt) }),
      publish,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value.post_id;
  }
  const report = (id: string, body: unknown, o: { device?: string | null; cookie?: string } = {}) =>
    app.request(`/api/posts/${id}/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(o.device === null ? {} : { "x-device-id": o.device ?? DEVICE_A }),
        ...(o.cookie ? { cookie: o.cookie } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const rowsOf = (id: string) =>
    db.select().from(s.reports).where(eq(s.reports.postId, id)).orderBy(s.reports.id);
  async function statusOf(id: string): Promise<PostStatus> {
    const rows = (await db.execute(
      sql`select status from post_status where id = ${id}`,
    )) as unknown as { status: PostStatus }[];
    return rows[0]?.status as PostStatus;
  }
  async function expectError(res: Response, status: number, error: string): Promise<void> {
    expect(await res.json()).toEqual({ error });
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }

  it("R-mo.A4-1 匿名で通報できる。行は open で、主体は X-Device-Id の actor、コメントは無ければ NULL", async () => {
    const id = await post();
    const res = await report(id, { category: "spam" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ reported: true });

    const [actor] = await db.select().from(s.actors).where(eq(s.actors.deviceId, DEVICE_A));
    expect(await rowsOf(id)).toEqual([
      {
        id: expect.any(Number),
        postId: id,
        actorId: actor?.id,
        category: "spam",
        comment: null,
        weight: 0,
        resolution: "open",
        createdAt: NOW,
      },
    ]);
  });

  it("R-mo.A4-1 コメントを保存する（前後の空白は落とす）。200 文字は通り、201 文字は invalid_request", async () => {
    const id = await post();
    const ok = "あ".repeat(REPORT_COMMENT_MAX);
    expect((await report(id, { category: "other", comment: ` ${ok}\n` })).status).toBe(200);
    expect((await rowsOf(id))[0]?.comment).toBe(ok);

    const other = await post();
    await expectError(
      await report(other, { category: "other", comment: "あ".repeat(REPORT_COMMENT_MAX + 1) }),
      400,
      "invalid_request",
    );
    expect(await rowsOf(other)).toHaveLength(0);
  });

  it("R-mo.A4-1 2 回目は何もせず成功。カテゴリやコメントを変えて送っても、最初の行が残る（I14）", async () => {
    const id = await post();
    await report(id, { category: "spam", comment: "最初" }, { cookie: newbie.cookie });
    const res = await report(
      id,
      { category: "sexual", comment: "2 回目" },
      { cookie: newbie.cookie },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reported: true });
    const rows = await rowsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "spam", comment: "最初", weight: 1 });
    // 別の端末は別の 1 件
    expect((await report(id, { category: "spam" }, { device: DEVICE_B })).status).toBe(200);
    expect(await rowsOf(id)).toHaveLength(2);
  });

  it("R-mo.A4-1 対象は limited / public / restricted。draft / unpublished / removed・存在しない ID は not_found で、行も主体も作らない", async () => {
    const limited = await post(true, newbie.id);
    const pub = await post();
    const restricted = await post();
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, restricted));
    const draft = await post(false);
    const unpublished = await post();
    await unpublishGame(deps, author.id, { post_id: unpublished });
    const removed = await post();
    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, removed));

    expect([await statusOf(limited), await statusOf(pub), await statusOf(restricted)]).toEqual([
      "limited",
      "public",
      "restricted",
    ]);
    expect([await statusOf(draft), await statusOf(unpublished), await statusOf(removed)]).toEqual([
      "draft",
      "unpublished",
      "removed",
    ]);

    for (const id of [draft, unpublished, removed, "01M782MV00TMYMTHTGG5C6KS3T", "nope"]) {
      await expectError(
        await report(id, { category: "spam" }, { cookie: trusted.cookie }),
        404,
        "not_found",
      );
    }
    expect(await db.select().from(s.reports)).toHaveLength(0);
    expect(await db.select().from(s.actors)).toHaveLength(0);

    for (const id of [limited, pub, restricted]) {
      expect((await report(id, { category: "spam" }, { cookie: trusted.cookie })).status).toBe(200);
      expect(await rowsOf(id)).toHaveLength(1);
    }
  });

  it("R-mo.A4-1 作者自身の通報は invalid で、行ができない。ログアウトしていても、作者に結ばれた端末なら同じ", async () => {
    const id = await post();
    await expectError(
      await report(id, { category: "spam" }, { cookie: author.cookie }),
      400,
      "invalid",
    );
    // 同じ端末は主体が作者に結ばれている（actors.user_id = posts.user_id）
    await expectError(await report(id, { category: "spam" }), 400, "invalid");
    expect(await rowsOf(id)).toHaveLength(0);
    // 作者でも、他人の投稿は通報できる
    const others = await post(true, newbie.id);
    expect((await report(others, { category: "spam" }, { cookie: author.cookie })).status).toBe(
      200,
    );
  });

  it("R-mo.A4-2 重みは受付時の trust_score ÷ 10 × 係数: 新規（1.0）と 50（5.0）の sexual / spam / broken", async () => {
    for (const category of ["sexual", "spam", "broken"] as const) {
      const id = await post();
      await report(id, { category }, { device: DEVICE_A, cookie: newbie.cookie });
      await report(id, { category }, { device: DEVICE_B, cookie: trusted.cookie });
      await report(id, { category }, { device: DEVICE_C });
      const weights = (await rowsOf(id)).map((r) => r.weight);
      expect(weights[0]).toBeCloseTo(1.0 * REPORT_COEF[category]);
      expect(weights[1]).toBeCloseTo(5.0 * REPORT_COEF[category]);
      // 匿名は 0（I14、R-dm.A5-14）
      expect(weights[2]).toBe(0);
    }
  });

  it("R-mo.A4-2 users 行の無いログイン（遊ぶだけの人）は匿名と同じで、重み 0", async () => {
    const id = await post();
    expect((await report(id, { category: "sexual" }, { cookie: player.cookie })).status).toBe(200);
    expect((await rowsOf(id))[0]?.weight).toBe(0);
  });

  it("R-mo.A4-2 通報の後で通報者の trust_score が変わっても、reports.weight は変わらない", async () => {
    const id = await post();
    await report(id, { category: "sexual" }, { cookie: newbie.cookie });
    await db.update(s.users).set({ trustScore: 80 }).where(eq(s.users.id, newbie.id));
    // もう一度送っても（重複は何もしない）、凍結した値のまま
    await report(id, { category: "sexual" }, { cookie: newbie.cookie });
    const rows = await rowsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weight).toBeCloseTo(3);
  });

  it("受付だけでは投稿状態・作者と通報者の trust_score・moderation_actions は変わらない（自動制限は別。R-mo.A4-3）", async () => {
    const id = await post();
    await report(id, { category: "sexual" }, { device: DEVICE_A, cookie: trusted.cookie });
    await report(id, { category: "sexual" }, { device: DEVICE_B, cookie: newbie.cookie });
    expect(await statusOf(id)).toBe("public");
    const trust = await db.select({ id: s.users.id, t: s.users.trustScore }).from(s.users);
    expect(Object.fromEntries(trust.map((u) => [u.id, u.t]))).toEqual({
      [author.id]: 30,
      [newbie.id]: 10,
      [trusted.id]: 50,
    });
    expect(await db.select().from(s.moderationActions)).toHaveLength(0);
  });

  it("X-Device-Id が無い・形式外は invalid_device。本文が JSON でない・カテゴリが違うときは invalid_request", async () => {
    const id = await post();
    await expectError(
      await report(id, { category: "spam" }, { device: null }),
      400,
      "invalid_device",
    );
    await expectError(
      await report(id, { category: "spam" }, { device: "bad id" }),
      400,
      "invalid_device",
    );
    await expectError(await report(id, "not json"), 400, "invalid_request");
    await expectError(await report(id, { category: "nope" }), 400, "invalid_request");
    await expectError(await report(id, {}), 400, "invalid_request");
    expect(await rowsOf(id)).toHaveLength(0);
  });

  it("通報者が誰か・重みを応答に出さない。GET /api/posts/{id} にも通報の情報は出ない", async () => {
    const id = await post();
    const res = await report(
      id,
      { category: "sexual", comment: "ひみつ" },
      { cookie: trusted.cookie },
    );
    expect(await res.text()).toBe('{"reported":true}');
    const text = await (await app.request(`/api/posts/${id}`)).text();
    expect(text).not.toMatch(/report|sexual|ひみつ|weight/);
  });
});
