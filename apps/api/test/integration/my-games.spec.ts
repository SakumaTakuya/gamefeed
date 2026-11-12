/**
 * `listMyGames` / `unpublishGame`（mcp.md A.3、moderation.md A.2 の `unpublish` の行）の integration テスト。
 * Postgres は本物、KV と時計は fake。下書き・公開は `publishGame` を通して作る。
 */

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user as authUser } from "../../src/db/auth-schema.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";
import { listMyGames, unpublishGame } from "../../src/my-games.ts";
import {
  type PublishDeps,
  type PublishInput,
  publishGame,
  type ServeValue,
} from "../../src/publish.ts";
import { gameHtml } from "../helpers/game-html.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので my-games の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const APP = "https://app.example.test";
const ME = "U00000000000000000000000ME";
const OTHER = "U0000000000000000000OTHER1";

dbSuite("list_my_games / unpublish_game（mc#A.3、mo#A.2）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let now: Date;
  let kvValues: Map<string, ServeValue>;
  let kvPuts: number;
  let deps: PublishDeps;

  beforeAll(async () => {
    const h = createDb(url as string, { max: 1 });
    db = h.db;
    close = h.close;
    await resetDb(db);
    await migrateDb(db);
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table reports, likes, post_stats, actors, posts, games, users, auth_user cascade`,
    );
    now = new Date("2026-11-11T03:00:00Z");
    kvValues = new Map();
    kvPuts = 0;
    deps = {
      db,
      storage: { put: async () => {} },
      kv: {
        put: async (id, v) => {
          kvPuts++;
          kvValues.set(id, v);
        },
      },
      appOrigin: APP,
      now: () => now,
    };
    for (const [id, trust] of [
      [ME, 30],
      [OTHER, 30],
    ] as const) {
      await db.insert(authUser).values({ id, name: "Taku Sakuma", email: `${id}@example.test` });
      await db
        .insert(s.users)
        .values({ id, handle: `h-${id.slice(-6).toLowerCase()}`, trustScore: trust });
    }
  });

  const tick = (ms = 1000) => {
    now = new Date(now.getTime() + ms);
  };
  async function pub(input: PublishInput, userId = ME) {
    const r = await publishGame(deps, userId, input);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    tick();
    return r.value;
  }
  /** trust_score を一時的に 10 にして公開する（limited になる。mo#A.2） */
  async function pubLimited(input: PublishInput) {
    await db.update(s.users).set({ trustScore: 10 }).where(eq(s.users.id, ME));
    const v = await pub({ ...input, publish: true });
    await db.update(s.users).set({ trustScore: 30 }).where(eq(s.users.id, ME));
    return v;
  }
  async function list(userId = ME) {
    const r = await listMyGames(deps, userId);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value.games;
  }
  const baseStatus = async (id: string) =>
    (await db.select().from(s.posts).where(eq(s.posts.id, id)))[0]?.baseStatus;
  async function addActor(id: string, userId: string | null = null) {
    await db.insert(s.actors).values({ id, deviceId: `dev-${id}`, userId });
  }

  // ---- list_my_games --------------------------------------------------------------

  it("R-mc.A3-2 投稿がなければ空。最初の呼び出しで users 行ができる（mc#A.5）", async () => {
    await db.execute(sql`delete from users where id = ${ME}`);
    expect(await list()).toEqual([]);
    expect(await db.select().from(s.users).where(eq(s.users.id, ME))).toHaveLength(1);
  });

  it("R-mc.A3-2 自分の投稿を updated_at の降順で返す。項目は mc#A.3 のとおり", async () => {
    const draft = await pub({ html: gameHtml({ salt: "d" }), title: "下書き" });
    const draftAt = new Date(now.getTime() - 1000);
    const live = await pub({ html: gameHtml({ salt: "p" }), title: "公開", publish: true });
    const liveAt = new Date(now.getTime() - 1000);
    await pub({ html: gameHtml({ salt: "o" }) }, OTHER);

    expect(await list()).toEqual([
      {
        post_id: live.post_id,
        title: "公開",
        status: "public",
        url: `${APP}/g/${live.post_id}`,
        calibration: "uncalibrated",
        plays: 0,
        likes: 0,
        calibration_remaining: 20,
        published_at: liveAt.toISOString(),
        updated_at: liveAt.toISOString(),
      },
      {
        post_id: draft.post_id,
        title: "下書き",
        status: "draft",
        url: `${APP}/draft/${draft.post_id}`,
        calibration: "uncalibrated",
        plays: 0,
        likes: 0,
        calibration_remaining: 20,
        published_at: null,
        updated_at: draftAt.toISOString(),
      },
    ]);
  });

  it("R-mc.A3-2 plays は post_stats.n、likes は件数。calibration_remaining は 20 − n（uncalibrated のときだけ、0 未満にしない）", async () => {
    const a = await pub({ html: gameHtml({ salt: "a" }), publish: true });
    const b = await pub({ html: gameHtml({ salt: "b" }), publish: true });
    const c = await pub({ html: gameHtml({ salt: "c" }), publish: true });
    await db.insert(s.postStats).values([
      { postId: a.post_id, n: 7, scores: [1, 2, 3, 4, 5, 6, 7] },
      { postId: b.post_id, n: 25, scores: Array.from({ length: 25 }, (_, i) => i) },
      { postId: c.post_id, n: 21, scores: Array.from({ length: 21 }, (_, i) => i) },
    ]);
    await db.update(s.posts).set({ calibration: "calibrated" }).where(eq(s.posts.id, b.post_id));
    await addActor("a1");
    await addActor("a2");
    await db.insert(s.likes).values([
      { postId: a.post_id, actorId: "a1" },
      { postId: a.post_id, actorId: "a2" },
      { postId: b.post_id, actorId: "a1" },
    ]);

    const byId = new Map((await list()).map((g) => [g.post_id, g]));
    expect(byId.get(a.post_id)).toMatchObject({ plays: 7, likes: 2, calibration_remaining: 13 });
    const gb = byId.get(b.post_id);
    expect(gb).toMatchObject({ plays: 25, likes: 1, calibration: "calibrated" });
    expect(gb).not.toHaveProperty("calibration_remaining");
    expect(byId.get(c.post_id)).toMatchObject({ plays: 21, likes: 0, calibration_remaining: 0 });
  });

  it("R-mc.A3-2 status は 6 値。restricted にだけ restricted_reason（通報カテゴリの集計。dismissed は数えない）", async () => {
    const r = await pub({ html: gameHtml({ salt: "r" }), publish: true });
    const u = await pub({ html: gameHtml({ salt: "u" }), publish: true });
    const x = await pub({ html: gameHtml({ salt: "x" }), publish: true });
    const l = await pubLimited({ html: gameHtml({ salt: "l" }) });
    const p = await pub({ html: gameHtml({ salt: "p" }), publish: true });
    const d = await pub({ html: gameHtml({ salt: "d" }) });
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, r.post_id));
    await db.update(s.posts).set({ baseStatus: "unpublished" }).where(eq(s.posts.id, u.post_id));
    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, x.post_id));
    for (const id of ["a1", "a2", "a3", "a4"]) await addActor(id, OTHER);
    await db.insert(s.reports).values([
      { postId: r.post_id, actorId: "a1", category: "sexual", weight: 3 },
      { postId: r.post_id, actorId: "a2", category: "sexual", weight: 3, resolution: "upheld" },
      { postId: r.post_id, actorId: "a3", category: "spam", weight: 1 },
      {
        postId: r.post_id,
        actorId: "a4",
        category: "broken",
        weight: 0.2,
        resolution: "dismissed",
      },
      // 制限されていない投稿の通報は出さない
      { postId: p.post_id, actorId: "a1", category: "spam", weight: 1 },
    ]);

    const byId = new Map((await list()).map((g) => [g.post_id, g]));
    expect(byId.get(r.post_id)).toMatchObject({
      status: "restricted",
      url: `${APP}/g/${r.post_id}`,
      restricted_reason: { sexual: 2, spam: 1 },
    });
    expect(byId.get(u.post_id)?.status).toBe("unpublished");
    expect(byId.get(x.post_id)?.status).toBe("removed");
    expect(byId.get(l.post_id)?.status).toBe("limited");
    expect(byId.get(p.post_id)?.status).toBe("public");
    expect(byId.get(d.post_id)?.status).toBe("draft");
    for (const id of [u, x, l, p, d].map((v) => v.post_id)) {
      expect(byId.get(id)).not.toHaveProperty("restricted_reason");
    }
  });

  it("R-mc.A3-2 最新の 50 件まで", async () => {
    for (let i = 0; i < 52; i++) {
      const id = `P${String(i).padStart(4, "0")}`;
      const hash = `hash-${i}`;
      await db.insert(s.games).values({ hash, size: 1, r2Key: `games/${hash}.html`, meta: {} });
      await db.insert(s.posts).values({
        id,
        userId: ME,
        gameHash: hash,
        title: id,
        prompt: "",
        treeId: id,
        updatedAt: new Date(now.getTime() + i * 1000),
      });
    }
    const games = await list();
    expect(games).toHaveLength(50);
    expect(games[0]?.post_id).toBe("P0051");
    expect(games[49]?.post_id).toBe("P0002");
  });

  // ---- unpublish_game -------------------------------------------------------------

  async function unpub(postId: string, userId = ME) {
    return unpublishGame(deps, userId, { post_id: postId });
  }

  it("mo#A.2 public / limited → unpublished。{post_id, status} を返し、KV は no になる", async () => {
    const p = await pub({ html: gameHtml({ salt: "p" }), publish: true });
    const l = await pubLimited({ html: gameHtml({ salt: "l" }) });
    expect(await baseStatus(l.post_id)).toBe("limited");
    expect(kvValues.get(p.post_id)?.status).toBe("ok");

    expect(await unpub(p.post_id)).toEqual({
      ok: true,
      value: { post_id: p.post_id, status: "unpublished" },
    });
    expect(await unpub(l.post_id)).toEqual({
      ok: true,
      value: { post_id: l.post_id, status: "unpublished" },
    });
    expect(await baseStatus(p.post_id)).toBe("unpublished");
    expect(await baseStatus(l.post_id)).toBe("unpublished");
    const hash = (await db.select().from(s.posts).where(eq(s.posts.id, p.post_id)))[0]?.gameHash;
    expect(kvValues.get(p.post_id)).toEqual({ hash, status: "no" });
    expect(kvValues.get(l.post_id)?.status).toBe("no");
  });

  it("se#A.5 KV に書けなかったら storage_failed（DB は unpublished のまま）。呼び直すと KV だけ書き直して成功する", async () => {
    const p = await pub({ html: gameHtml(), publish: true });
    const working = deps.kv;
    let attempts = 0;
    deps = {
      ...deps,
      kv: {
        put: async () => {
          attempts++;
          throw new Error("KV に届かない（fake）");
        },
      },
    };
    const failed = await unpub(p.post_id);
    expect(failed.ok ? null : failed.error.code).toBe("storage_failed");
    expect(attempts).toBe(3);
    expect(await baseStatus(p.post_id)).toBe("unpublished");
    expect(kvValues.get(p.post_id)?.status).toBe("ok");

    deps = { ...deps, ...(working ? { kv: working } : {}) };
    expect(await unpub(p.post_id)).toEqual({
      ok: true,
      value: { post_id: p.post_id, status: "unpublished" },
    });
    expect(kvValues.get(p.post_id)?.status).toBe("no");
  });

  it("mo#A.2 draft は R2 に内容が無くても何もせず成功（止める配信が無いので KV を触らない）", async () => {
    // R2 に置けなかった下書き（stored_at NULL、KV なし）
    const html = gameHtml({ salt: "unstored" });
    const failing = { ...deps, storage: { put: () => Promise.reject(new Error("R2 に届かない")) } };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await publishGame(failing, ME, { html });
    logged.mockRestore();
    expect(r.ok ? null : r.error.code).toBe("storage_failed");
    const [p] = await db.select().from(s.posts);
    if (!p) throw new Error("投稿が無い");
    const puts = kvPuts;
    expect(await unpub(p.id)).toEqual({ ok: true, value: { post_id: p.id, status: "draft" } });
    expect(kvPuts).toBe(puts);
  });

  it("mo#A.2 unpublished / draft には何もせず成功（状態を変えず、unpublished の KV は同じ値を書き直すだけ）", async () => {
    const d = await pub({ html: gameHtml({ salt: "d" }) });
    const p = await pub({ html: gameHtml({ salt: "p" }), publish: true });
    await unpub(p.post_id);
    expect(await unpub(p.post_id)).toEqual({
      ok: true,
      value: { post_id: p.post_id, status: "unpublished" },
    });
    expect(await unpub(d.post_id)).toEqual({
      ok: true,
      value: { post_id: d.post_id, status: "draft" },
    });
    expect(await baseStatus(d.post_id)).toBe("draft");
    expect(await baseStatus(p.post_id)).toBe("unpublished");
    expect(kvValues.get(d.post_id)?.status).toBe("draft");
    expect(kvValues.get(p.post_id)?.status).toBe("no");
  });

  it("mo#A.2 制限中の投稿も unpublished にできる。制限（indiv_restricted）と通報は触らない", async () => {
    const r = await pub({ html: gameHtml(), publish: true });
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, r.post_id));
    await addActor("a1", OTHER);
    await db
      .insert(s.reports)
      .values({ postId: r.post_id, actorId: "a1", category: "spam", weight: 1 });

    expect(await unpub(r.post_id)).toEqual({
      ok: true,
      value: { post_id: r.post_id, status: "unpublished" },
    });
    const [row] = await db.select().from(s.posts).where(eq(s.posts.id, r.post_id));
    expect(row).toMatchObject({ baseStatus: "unpublished", indivRestricted: true });
    const reports = await db.select().from(s.reports);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.resolution).toBe("open");
  });

  it("R-mc.A10-1 removed は invalid_state。他人の投稿と存在しない post_id は同じ not_found で、何も変えない", async () => {
    const x = await pub({ html: gameHtml({ salt: "x" }), publish: true });
    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, x.post_id));
    const theirs = await pub({ html: gameHtml({ salt: "t" }), publish: true }, OTHER);
    const puts = kvPuts;

    const removed = await unpub(x.post_id);
    expect(removed.ok ? null : removed.error.code).toBe("invalid_state");
    const a = await unpub(theirs.post_id);
    const b = await unpub("01JZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(a.ok ? null : a.error.code).toBe("not_found");
    expect(a).toEqual(b);
    expect(await baseStatus(theirs.post_id)).toBe("public");
    expect(await baseStatus(x.post_id)).toBe("removed");
    expect(kvPuts).toBe(puts);
  });

  it("R-mo.A5-2 post_restricted のユーザーも list_my_games と unpublish_game は通る", async () => {
    const p = await pub({ html: gameHtml(), publish: true });
    await db.update(s.users).set({ status: "post_restricted" }).where(eq(s.users.id, ME));
    expect(await list()).toHaveLength(1);
    expect((await unpub(p.post_id)).ok).toBe(true);
    expect(await baseStatus(p.post_id)).toBe("unpublished");
  });

  it("mc#A.2 list_my_games / unpublish_game は DB だけで動く（R2 / KV が未設定でも通る）", async () => {
    const p = await pub({ html: gameHtml(), publish: true });
    const bare: PublishDeps = { db, appOrigin: APP, now: () => now };
    expect((await listMyGames(bare, ME)).ok).toBe(true);
    expect(await unpublishGame(bare, ME, { post_id: p.post_id })).toEqual({
      ok: true,
      value: { post_id: p.post_id, status: "unpublished" },
    });
  });

  it("mc#A.2 banned のユーザーは banned で拒否される", async () => {
    const p = await pub({ html: gameHtml(), publish: true });
    await db.update(s.users).set({ status: "banned" }).where(eq(s.users.id, ME));
    const l = await listMyGames(deps, ME);
    expect(l.ok ? null : l.error.code).toBe("banned");
    const u = await unpub(p.post_id);
    expect(u.ok ? null : u.error.code).toBe("banned");
    expect(await baseStatus(p.post_id)).toBe("public");
  });
});
