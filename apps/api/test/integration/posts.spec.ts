/**
 * `GET /api/posts/{id}`（公開済みの投稿を読む。ゲームページが使う）の integration テスト。
 * R-mo.A3-1 の直リンクの部分（moderation.md A.3、mcp.md A.9）。一覧 API はまだ無い。
 * Postgres と Better Auth は本物（ログインは testUtils）、R2 / KV は fake。
 */

import { CALIBRATION_MIN_PLAYS, deviation, histogram } from "@gamefeed/domain";
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
      liked: false,
      stats: null,
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
      liked: false,
      stats: null,
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

  // --- いいね（product#3 の 5、dm の I14。#199） ---

  const DEVICE_A = "AAAAAAAAAAAAAAAAAAAAAA";
  const DEVICE_B = "BBBBBBBBBBBBBBBBBBBBBB";
  const like = (id: string, device?: string, cookie?: string) =>
    app.request(`/api/posts/${id}/like`, {
      method: "PUT",
      headers: { ...(device ? { "x-device-id": device } : {}), ...(cookie ? { cookie } : {}) },
    });
  const getAs = async (id: string, device?: string) =>
    (await (
      await app.request(`/api/posts/${id}`, { headers: device ? { "x-device-id": device } : {} })
    ).json()) as { liked: boolean };
  const likeRows = (id: string) => db.select().from(s.likes).where(eq(s.likes.postId, id));

  it("R-run.A14-4 匿名でいいねできる。同じ端末の 2 回目も同じ応答で、行は 1 つ（I14）", async () => {
    const id = await post(true);
    for (let i = 0; i < 2; i++) {
      const res = await like(id, DEVICE_A);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ liked: true });
    }
    const rows = await likeRows(id);
    expect(rows).toHaveLength(1);
    const [actor] = await db.select().from(s.actors).where(eq(s.actors.deviceId, DEVICE_A));
    expect(rows[0]?.actorId).toBe(actor?.id);
    expect(actor?.userId).toBeNull();
    expect(rows[0]?.createdAt).toEqual(NOW);
  });

  it("R-run.A14-4 別の端末は別の 1 件。limited の投稿にも、自分の投稿にもいいねできる", async () => {
    const id = await post(true, newbie.id);
    expect(await statusOf(id)).toBe("limited");
    expect((await like(id, DEVICE_A)).status).toBe(200);
    expect((await like(id, DEVICE_B, newbie.cookie)).status).toBe(200);
    expect(await likeRows(id)).toHaveLength(2);
  });

  it("R-run.A14-4 ログイン中のいいねは、主体に user_id を結ぶ（dm#A.3）", async () => {
    const id = await post(true);
    expect((await like(id, DEVICE_A, me.cookie)).status).toBe(200);
    const [actor] = await db.select().from(s.actors).where(eq(s.actors.deviceId, DEVICE_A));
    expect(actor?.userId).toBe(me.id);
  });

  it("R-run.A14-4 GET は X-Device-Id の端末がいいね済みかを liked で返す。主体は作らない", async () => {
    const id = await post(true);
    const other = await post(true);
    await like(id, DEVICE_A);
    expect((await getAs(id, DEVICE_A)).liked).toBe(true);
    expect((await getAs(other, DEVICE_A)).liked).toBe(false);
    expect((await getAs(id, DEVICE_B)).liked).toBe(false);
    expect((await getAs(id)).liked).toBe(false);
    expect((await getAs(id, "bad id")).liked).toBe(false);
    // 読むだけでは主体を作らない
    expect(await db.select().from(s.actors)).toHaveLength(1);
  });

  it("R-run.A14-4 見られない投稿・存在しない ID・形式外の ID へのいいねは not_found で、行も主体も作らない", async () => {
    const draft = await post(false);
    const restricted = await post(true);
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, restricted));
    const unpublished = await post(true);
    await unpublishGame(deps, me.id, { post_id: unpublished });
    const removed = await post(true);
    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, removed));
    for (const id of [
      draft,
      restricted,
      unpublished,
      removed,
      "01M782MV00TMYMTHTGG5C6KS3T",
      "nope",
    ]) {
      await expectNotFound(await like(id, DEVICE_A, me.cookie));
    }
    expect(await db.select().from(s.likes)).toHaveLength(0);
    expect(await db.select().from(s.actors)).toHaveLength(0);
  });

  it("R-run.A14-4 X-Device-Id が無い・形式外なら invalid_device（ログインしていても）", async () => {
    const id = await post(true);
    for (const device of [undefined, "short", "has space in the device id!"]) {
      const res = await like(id, device, me.cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_device" });
    }
    expect(await likeRows(id)).toHaveLength(0);
  });

  it("R-run.A14-4 いいねの後に見られなくなった投稿は、GET も PUT も not_found", async () => {
    const id = await post(true);
    await like(id, DEVICE_A);
    await unpublishGame(deps, me.id, { post_id: id });
    await expectNotFound(await like(id, DEVICE_A));
    await expectNotFound(
      await app.request(`/api/posts/${id}`, { headers: { "x-device-id": DEVICE_A } }),
    );
  });

  // --- プレイ数・いいね数と「今の偏差値」（product#5.3、product#9 の 5。#211） ---

  /** 昇順、20 件 */
  const DIST = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
  async function setStats(
    id: string,
    calibration: "uncalibrated" | "calibrated" | "review" | "invalid",
    scores: number[],
  ): Promise<void> {
    await db.insert(s.postStats).values({ postId: id, n: scores.length, scores });
    await db.update(s.posts).set({ calibration }).where(eq(s.posts.id, id));
  }
  const statsOf = async (id: string) =>
    ((await (await get(id)).json()) as { stats: unknown }).stats;
  const dev = (id: string, query: string) => app.request(`/api/posts/${id}/deviation${query}`);

  it("R-run.A14-6 校正済みの投稿は stats にプレイ数（分布の件数）といいね数を返す", async () => {
    const id = await post(true);
    await setStats(id, "calibrated", DIST);
    expect(await statsOf(id)).toMatchObject({ plays: 20, likes: 0 });
    await like(id, DEVICE_A);
    await like(id, DEVICE_B);
    await like(id, DEVICE_B);
    expect(await statsOf(id)).toMatchObject({ plays: 20, likes: 2 });
    // ほかの投稿の数は混ざらない
    const other = await post(true);
    await setStats(other, "calibrated", [...DIST, 500]);
    expect(await statsOf(other)).toMatchObject({ plays: 21, likes: 0 });
  });

  it("R-run.A14-7 校正済みの投稿は stats.histogram に点数の分布の区間を返す（domain の histogram と同じ値。分布そのものは返さない）", async () => {
    const id = await post(true);
    await setStats(id, "calibrated", DIST);
    const stats = (await statsOf(id)) as {
      histogram: { from: number; to: number; count: number }[];
    };
    expect(stats).toEqual({ plays: 20, likes: 0, histogram: histogram(DIST) });
    expect(stats.histogram).toHaveLength(12);
    expect(stats.histogram.reduce((sum, b) => sum + b.count, 0)).toBe(20);
    expect(Object.keys(stats)).not.toContain("scores");
    // 並びが崩れた配列でも同じ（dm#A.3 は昇順。崩れていても図がずれない）
    const shuffled = await post(true);
    await setStats(shuffled, "calibrated", [...DIST].reverse());
    expect(((await statsOf(shuffled)) as typeof stats).histogram).toEqual(histogram(DIST));
  });

  it("R-run.A14-6 校正済みでない投稿（未校正・要確認・不成立、集計の行が無い）は stats が null", async () => {
    const fresh = await post(true);
    expect(await statsOf(fresh)).toBeNull();
    for (const calibration of ["uncalibrated", "review", "invalid"] as const) {
      const id = await post(true);
      await setStats(id, calibration, DIST);
      await like(id, DEVICE_A);
      expect(await statsOf(id)).toBeNull();
    }
  });

  it("R-run.A14-6 今の偏差値は、今の分布に対する domain の deviation と同じ値。分布が動けば変わる", async () => {
    const id = await post(true, newbie.id);
    await setStats(id, "calibrated", DIST);
    for (const score of [0, 10, 105, 200, 9999]) {
      const res = await dev(id, `?score=${score}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ deviation: deviation(score, DIST) });
    }
    const before = deviation(105, DIST);
    const moved = [...DIST, 300, 300, 300, 300, 300];
    await db
      .update(s.postStats)
      .set({ n: moved.length, scores: moved })
      .where(eq(s.postStats.postId, id));
    const after = ((await (await dev(id, "?score=105")).json()) as { deviation: number }).deviation;
    expect(after).toBe(deviation(105, moved));
    expect(after).toBeLessThan(before);
  });

  it("R-run.A14-6 校正済みでない投稿と、分布が 5 件に満たない投稿は deviation が null（sc#A.5）", async () => {
    const fresh = await post(true);
    expect(await (await dev(fresh, "?score=10")).json()).toEqual({ deviation: null });
    for (const calibration of ["uncalibrated", "review", "invalid"] as const) {
      const id = await post(true);
      await setStats(id, calibration, DIST);
      expect(await (await dev(id, "?score=10")).json()).toEqual({ deviation: null });
    }
    const thin = await post(true);
    await setStats(thin, "calibrated", DIST.slice(0, CALIBRATION_MIN_PLAYS - 1));
    expect(await (await dev(thin, "?score=10")).json()).toEqual({ deviation: null });
    // ちょうど 5 件なら出る（#242）
    const five = await post(true);
    await setStats(five, "calibrated", DIST.slice(0, CALIBRATION_MIN_PLAYS));
    expect(await (await dev(five, "?score=35")).json()).toEqual({
      deviation: deviation(35, DIST.slice(0, 5)),
    });
  });

  it("R-run.A14-6 score が 0 以上 2^31 − 1 以下の整数の 10 進表記でなければ invalid_request", async () => {
    const id = await post(true);
    await setStats(id, "calibrated", DIST);
    for (const q of [
      "",
      "?score=",
      "?score=abc",
      "?score=-1",
      "?score=1.5",
      "?score=1e3",
      "?score=%2010",
      "?score=0x10",
      "?score=2147483648",
      "?other=10",
    ]) {
      const res = await dev(id, q);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect((await dev(id, "?score=2147483647")).status).toBe(200);
  });

  it("R-run.A14-6 見られない投稿・存在しない ID の deviation は not_found。読むだけで何も書かない", async () => {
    const draft = await post(false);
    const restricted = await post(true);
    await setStats(restricted, "calibrated", DIST);
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, restricted));
    const unpublished = await post(true);
    await unpublishGame(deps, me.id, { post_id: unpublished });
    for (const id of [draft, restricted, unpublished, "01M782MV00TMYMTHTGG5C6KS3T", "nope"]) {
      await expectNotFound(await dev(id, "?score=10"));
    }
    const open = await post(true);
    await setStats(open, "calibrated", DIST);
    const res = await app.request(`/api/posts/${open}/deviation?score=50`, {
      headers: { "x-device-id": DEVICE_A, cookie: "better-auth.session_token=garbage" },
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(s.actors)).toHaveLength(0);
    const [stat] = await db.select().from(s.postStats).where(eq(s.postStats.postId, open));
    expect(stat?.scores).toEqual(DIST);
  });
});
