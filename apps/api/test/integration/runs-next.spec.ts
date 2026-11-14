/**
 * `POST /api/runs/{id}/next`（手番の発行）の integration テスト。
 * run#A.3 / A.8、sc#A.6、mo#A.3、dm#A.5 I12・I13。R-run.A3-1、R-sc.A6-1（発行時に null にする条件）、R-mo.A3-2（next の部分）。
 * Postgres と Better Auth は本物。乱数は seed から決まるものを渡す。
 * 結果の受理（`result`）は #128 なので、ここでは `sessions` と `post_stats` を直接書いて「記録された後」を作る。
 * 応答のステータスやエラーなど仕様に未記載の点は #143 の案。
 */
import { CALIBRATION_MIN_PLAYS, ENDLESS_TURN_LIMIT, missBelow, SPEED_MAX } from "@gamefeed/domain";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEVICE_ID_HEADER } from "../../src/actors.ts";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので next の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const NOW = new Date("2026-11-14T03:00:00Z");
const DEVICE_A = "0123456789abcdef0123456789abcdef";
const DEVICE_B = "fedcba9876543210fedcba9876543210";
const DURATION_FRAMES = 300;

/** seed から決まる乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 校正済みのゲームの分布（昇順、20 件）。偏差値 40 の境界は 30 点 */
const DIST = Array.from({ length: CALIBRATION_MIN_PLAYS }, (_, i) => (i + 1) * 10);

interface Turn {
  turn: number;
  post_id: string;
  session_id: string;
  seed: number;
  speed: number;
  is_new: boolean;
  lap: number;
  miss_below: number | null;
}

dbSuite("POST /api/runs/{id}/next（run#A.3）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let auth: ReturnType<typeof createAuth>;
  let login: (email: string) => Promise<{ id: string; cookie: string }>;

  beforeAll(async () => {
    // 同時の発行を本当に並行させるため、接続は複数にする
    const h = createDb(url as string, { max: 4 });
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
      sql`truncate table sessions, runs, reports, likes, post_stats, tree_locks, moderation_actions, actors, posts, games, users, auth_user cascade`,
    );
    auth = createAuth({
      baseURL: BASE,
      secret: "test-secret-".repeat(4),
      db,
      extraPlugins: [testUtils()],
    });
    app = createApp({
      auth,
      baseURL: BASE,
      publish: { db, appOrigin: BASE, now: () => NOW },
      random: rng(1),
    });
    const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    login = async (email) => {
      const user = test.createUser({ email, name: "Taku Sakuma" });
      await test.saveUser(user);
      const { cookies } = await test.login({ userId: user.id });
      await db.insert(s.users).values({ id: user.id, handle: email.split("@")[0] ?? "h" });
      return { id: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    };
    await db.insert(s.users).values({ id: "author", handle: "author" });
    await db.insert(s.games).values({
      hash: "h-1",
      size: 1024,
      r2Key: "games/h-1.html",
      meta: {
        title: "押せ！",
        verb: "押せ！",
        input: "tap",
        duration_frames: DURATION_FRAMES,
        target: 12,
        deterministic: true,
        warnings: [],
      },
    });
  });

  // ---- fixtures -----------------------------------------------------------------

  interface PostOpts {
    calibration?: "uncalibrated" | "calibrated";
    userId?: string;
    /** 分布（post_stats）。校正済みの既定は DIST、未校正は無し */
    dist?: number[] | null;
  }
  async function seedPost(id: string, o: PostOpts = {}): Promise<string> {
    const calibration = o.calibration ?? "calibrated";
    await db.insert(s.posts).values({
      id,
      userId: o.userId ?? "author",
      gameHash: "h-1",
      title: id,
      prompt: "",
      treeId: id,
      depth: 0,
      calibration,
      thumbKey: `thumbs/${id}.webp`,
    });
    await db.execute(
      sql`update posts set base_status = 'public', published_at = now() where id = ${id}`,
    );
    const dist = o.dist === undefined ? (calibration === "calibrated" ? DIST : null) : o.dist;
    if (dist) await setDist(id, dist);
    return id;
  }
  const seedPosts = (prefix: string, n: number, o: PostOpts = {}) =>
    Promise.all(Array.from({ length: n }, (_, i) => seedPost(`${prefix}${i}`, o)));

  async function setDist(postId: string, dist: number[]): Promise<void> {
    const scores = [...dist].sort((a, b) => a - b);
    await db
      .insert(s.postStats)
      .values({ postId, n: scores.length, scores })
      .onConflictDoUpdate({ target: s.postStats.postId, set: { n: scores.length, scores } });
  }

  interface Req {
    device?: string | null;
    cookie?: string;
    userAgent?: string;
  }
  function headers(o: Req): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const device = o.device === undefined ? DEVICE_A : o.device;
    if (device !== null) h[DEVICE_ID_HEADER] = device;
    if (o.cookie) h.cookie = o.cookie;
    if (o.userAgent) h["user-agent"] = o.userAgent;
    return h;
  }
  async function createRun(o: Req = {}): Promise<{ run_id: string; deck: string[] }> {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: headers(o),
      body: JSON.stringify({ mode: "endless" }),
    });
    const body = (await res.json()) as { run_id: string; deck: { post_id: string }[] };
    expect(res.status, JSON.stringify(body)).toBe(201);
    return { run_id: body.run_id, deck: body.deck.map((d) => d.post_id) };
  }
  const postNext = (runId: string, o: Req = {}) =>
    app.request(`/api/runs/${runId}/next`, { method: "POST", headers: headers(o) });
  async function next(runId: string, o: Req = {}): Promise<Turn> {
    const res = await postNext(runId, o);
    const body = (await res.json()) as Turn;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body, "done ではなく手番が返る").toHaveProperty("session_id");
    return body;
  }
  async function expectDone(runId: string, o: Req = {}): Promise<void> {
    const res = await postNext(runId, o);
    expect(await res.json()).toEqual({ done: true });
    expect(res.status).toBe(200);
  }
  async function expectError(res: Response, status: number, error: string): Promise<void> {
    expect(await res.json()).toMatchObject({ error });
    expect(res.status).toBe(status);
  }
  const sessionRows = () => db.select().from(s.sessions).orderBy(s.sessions.turn);
  const sessionOf = async (id: string) =>
    (await db.select().from(s.sessions).where(eq(s.sessions.id, id)))[0];
  /** 手番の結果を「記録された」状態にする（受理は #128。ここでは行を直接書く） */
  async function record(sessionId: string, score: number): Promise<void> {
    await db
      .update(s.sessions)
      .set({
        state: "submitted",
        via: "guest",
        score,
        frames: DURATION_FRAMES,
        submittedAt: NOW,
      })
      .where(eq(s.sessions.id, sessionId));
  }
  const restrict = (postId: string) =>
    db.execute(sql`update posts set indiv_restricted = true where id = ${postId}`);

  // ---- 手番の発行 ------------------------------------------------------------------

  describe("手番の発行", () => {
    it("R-run.A3-1 最初の手番: {turn, post_id, session_id, seed, speed, is_new, lap, miss_below} を返し、sessions に open の 1 行ができる", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      const res = await postNext(run.run_id);
      const body = (await res.json()) as Turn;
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(Object.keys(body).sort()).toEqual(
        ["turn", "post_id", "session_id", "seed", "speed", "is_new", "lap", "miss_below"].sort(),
      );
      expect(body).toMatchObject({
        turn: 0,
        // 配信用の値: Host は post_id からゲーム URL（<games-origin>/p/<post_id>/）を組む（se#A.2）
        post_id: run.deck[0],
        speed: 1,
        is_new: false,
        lap: 0,
        miss_below: missBelow(DIST),
      });
      expect(body.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // seed は 32 bit 符号なし（protocol#A.3）
      expect(Number.isInteger(body.seed)).toBe(true);
      expect(body.seed).toBeGreaterThanOrEqual(0);
      expect(body.seed).toBeLessThan(2 ** 32);

      const [row, ...rest] = await sessionRows();
      expect(rest).toEqual([]);
      const [actor] = await db.select().from(s.actors);
      expect(row).toMatchObject({
        id: body.session_id,
        postId: run.deck[0],
        gameHash: "h-1",
        actorId: actor?.id,
        deviceKind: "other",
        runId: run.run_id,
        turn: 0,
        mode: "play",
        seed: body.seed,
        speed: "1.000",
        timeLimit: DURATION_FRAMES,
        missBelow: body.miss_below,
        isNew: false,
        author: false,
        state: "open",
        via: null,
        score: null,
        frames: null,
        verdict: "provisional",
        deviation: null,
        submittedAt: null,
      });
      expect(row?.issuedAt.toISOString()).toBe(NOW.toISOString());
    });

    it("R-run.A3-1 先読みで結果を待たずに N+1、N+2 を発行できる。手番は山札の順で、seed と session_id は手番ごとに違う", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      const turns = [await next(run.run_id), await next(run.run_id), await next(run.run_id)];
      expect(turns.map((t) => t.turn)).toEqual([0, 1, 2]);
      expect(turns.map((t) => t.post_id)).toEqual(run.deck.slice(0, 3));
      expect(new Set(turns.map((t) => t.session_id)).size).toBe(3);
      expect(new Set(turns.map((t) => t.seed)).size).toBe(3);
      expect((await sessionRows()).map((r) => r.state)).toEqual(["open", "open", "open"]);
    });

    it("R-run.A3-1 山札 12・上限 50: 周回ごとに速度が上がり、50 手番を発行した後の 51 回目は {done: true}", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      for (let i = 0; i < ENDLESS_TURN_LIMIT; i++) {
        const t = await next(run.run_id);
        const lap = Math.floor(i / 12);
        expect(t).toMatchObject({
          turn: i,
          post_id: run.deck[i % 12],
          lap,
          speed: Math.min(SPEED_MAX, 1 + 0.125 * lap),
        });
      }
      await expectDone(run.run_id);
      await expectDone(run.run_id);
      const rows = await sessionRows();
      expect(rows).toHaveLength(ENDLESS_TURN_LIMIT);
      // I12: speed は 5 値のどれか。発行した値がそのまま残る（検証はこの値を信じる。run#A.3）
      expect(rows[49]).toMatchObject({ turn: 49, speed: "1.500" });
      expect(rows[12]).toMatchObject({ turn: 12, speed: "1.125" });
    }, 30_000);

    it("R-run.A3-1 ミス 3 回が記録された後は {done: true}。2 回までは続く", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      const below = missBelow(DIST);
      expect(below).toBeGreaterThan(0);
      for (let i = 0; i < 2; i++) await record((await next(run.run_id)).session_id, below - 1);
      // 閾値ちょうどはミスではない（ミスは score < miss_below。sc#A.6）
      await record((await next(run.run_id)).session_id, below);
      const third = await next(run.run_id);
      expect(third.turn).toBe(3);
      await record(third.session_id, 0);
      await expectDone(run.run_id);
      expect(await sessionRows()).toHaveLength(4);
    });

    it("R-run.A3-1 先読みで発行済みの手番は、残機が切れた後もそのまま残る（捨てるのは finish）", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      const turns = [];
      for (let i = 0; i < 5; i++) turns.push(await next(run.run_id));
      for (const t of turns.slice(0, 3)) await record(t.session_id, 0);
      await expectDone(run.run_id);
      expect((await sessionRows()).map((r) => r.state)).toEqual([
        "submitted",
        "submitted",
        "submitted",
        "open",
        "open",
      ]);
    });

    it("R-run.A3-1 新作扱いの手番（miss_below: null）は何点でもミスに数えない（run#A.15 F7）", async () => {
      await seedPosts("u", 4, { calibration: "uncalibrated" });
      const run = await createRun();
      for (let i = 0; i < 6; i++) {
        const t = await next(run.run_id);
        expect(t).toMatchObject({ turn: i, is_new: true, miss_below: null });
        await record(t.session_id, 0);
      }
      expect((await next(run.run_id)).turn).toBe(6);
    });

    it("R-run.A3-1 終わったラン（finish 済み）は {done: true} で、手番を発行しない", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      await next(run.run_id);
      await db
        .update(s.runs)
        .set({ ended: "abandoned", endedAt: NOW, reached: 0 })
        .where(eq(s.runs.id, run.run_id));
      await expectDone(run.run_id);
      expect(await sessionRows()).toHaveLength(1);
    });
  });

  // ---- miss_below の凍結（sc#A.6、I12） ---------------------------------------------

  describe("miss_below の凍結", () => {
    it("R-run.A3-1 miss_below は発行時点の分布から求め、発行後に分布へ結果が足されても変わらない。次の発行は新しい分布から求める", async () => {
      await seedPost("solo");
      const run = await createRun();
      const first = await next(run.run_id);
      expect(first.miss_below).toBe(missBelow(DIST));

      // 高い点が 20 件足されて、偏差値 40 の境界が上がる
      const grown = [...DIST, ...Array.from({ length: 20 }, () => 500)];
      await setDist("solo", grown);
      expect(missBelow(grown)).not.toBe(missBelow(DIST));
      expect((await sessionOf(first.session_id))?.missBelow).toBe(first.miss_below);

      // 山札 1 本なので次の手番は同じゲームの 2 周目
      const second = await next(run.run_id);
      expect(second).toMatchObject({ turn: 1, post_id: "solo", lap: 1, speed: 1.125 });
      expect(second.miss_below).toBe(missBelow(grown));
      expect((await sessionOf(first.session_id))?.missBelow).toBe(first.miss_below);
    });

    it("R-sc.A6-1 新作枠・未校正で埋めた手番は null、校正済みの手番だけ値を持つ", async () => {
      await seedPosts("c", 3);
      await seedPosts("u", 2, { calibration: "uncalibrated" });
      const run = await createRun();
      for (let i = 0; i < run.deck.length; i++) {
        const t = await next(run.run_id);
        const isNew = t.post_id.startsWith("u");
        expect(t.is_new).toBe(isNew);
        expect(t.miss_below).toBe(isNew ? null : missBelow(DIST));
        expect((await sessionOf(t.session_id))?.missBelow).toBe(t.miss_below);
      }
    });

    it("R-sc.A6-1 新作枠のゲームがラン中に校正済みになっても、その手番は新作扱いのまま null（山札は開始時に確定）", async () => {
      await seedPost("u0", { calibration: "uncalibrated" });
      const run = await createRun();
      await db.execute(sql`update posts set calibration = 'calibrated' where id = 'u0'`);
      await setDist("u0", DIST);
      expect(await next(run.run_id)).toMatchObject({ is_new: true, miss_below: null });
    });

    it("R-sc.A6-1 0 点が 16% 以上の分布では miss_below は 0（ミスが起きない）で、null とは区別する", async () => {
      const zeros = [...Array.from({ length: 10 }, () => 0), ...DIST.slice(10)];
      await seedPost("z", { dist: zeros });
      const run = await createRun();
      const t = await next(run.run_id);
      expect(t.miss_below).toBe(0);
      expect((await sessionOf(t.session_id))?.missBelow).toBe(0);
    });

    it("R-sc.A6-1 校正済みでも分布が 20 件に満たなければ null（偏差値を出せない。sc#A.5）", async () => {
      await seedPost("few", { dist: DIST.slice(0, CALIBRATION_MIN_PLAYS - 1) });
      await seedPost("none", { dist: null });
      const run = await createRun();
      for (let i = 0; i < 2; i++) {
        expect(await next(run.run_id)).toMatchObject({ is_new: false, miss_below: null });
      }
    });
  });

  // ---- 並行（I13） ----------------------------------------------------------------

  describe("同時の発行", () => {
    it("R-run.A3-1 同時に 2 回呼んでも (run_id, turn) は重複せず、両方が別の手番を受け取る", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      const results = await Promise.all([postNext(run.run_id), postNext(run.run_id)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const bodies = (await Promise.all(results.map((r) => r.json()))) as Turn[];
      expect(bodies.map((b) => b.turn).sort()).toEqual([0, 1]);
      expect(new Set(bodies.map((b) => b.post_id))).toEqual(new Set(run.deck.slice(0, 2)));
      expect((await sessionRows()).map((r) => r.turn)).toEqual([0, 1]);
    });

    it("R-run.A3-1 上限の手前で同時に 8 回呼んでも、発行は上限までで残りは done", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      for (let i = 0; i < ENDLESS_TURN_LIMIT - 3; i++) await next(run.run_id);
      const results = await Promise.all(Array.from({ length: 8 }, () => postNext(run.run_id)));
      expect(results.map((r) => r.status)).toEqual(Array.from({ length: 8 }, () => 200));
      const bodies = (await Promise.all(results.map((r) => r.json()))) as (Turn | { done: true })[];
      expect(bodies.filter((b) => "done" in b)).toHaveLength(5);
      expect(bodies.flatMap((b) => ("turn" in b ? [b.turn] : [])).sort((a, b) => a - b)).toEqual([
        47, 48, 49,
      ]);
      const turns = (await sessionRows()).map((r) => r.turn);
      expect(turns).toEqual(Array.from({ length: ENDLESS_TURN_LIMIT }, (_, i) => i));
    }, 30_000);
  });

  // ---- 出せなくなった投稿（mo#A.3） -------------------------------------------------

  describe("出せなくなった投稿", () => {
    it("R-mo.A3-2 ラン開始後に制限された投稿は手番を消費せずに飛ばし、turn は連番のまま", async () => {
      await seedPosts("c", 12);
      const run = await createRun();
      const first = await next(run.run_id);
      await restrict(run.deck[1] as string);
      await restrict(run.deck[2] as string);
      const second = await next(run.run_id);
      expect(first).toMatchObject({ turn: 0, post_id: run.deck[0] });
      expect(second).toMatchObject({ turn: 1, post_id: run.deck[3], lap: 0, speed: 1 });
      expect(await next(run.run_id)).toMatchObject({ turn: 2, post_id: run.deck[4] });
      expect((await sessionRows()).map((r) => r.turn)).toEqual([0, 1, 2]);
    });

    it("R-mo.A3-2 非公開・削除・校正が review / invalid になった投稿も飛ばす。発行済みの手番は残る", async () => {
      await seedPosts("c", 6);
      const run = await createRun();
      const issued = await next(run.run_id);
      const [d0, d1, d2, d3, d4] = run.deck as [string, string, string, string, string];
      await db.execute(sql`update posts set base_status = 'unpublished' where id = ${d0}`);
      await db.execute(sql`update posts set base_status = 'unpublished' where id = ${d1}`);
      await db.execute(sql`update posts set base_status = 'removed' where id = ${d2}`);
      await db.execute(sql`update posts set calibration = 'review' where id = ${d3}`);
      await db.execute(sql`update posts set calibration = 'invalid' where id = ${d4}`);
      expect(await next(run.run_id)).toMatchObject({ turn: 1, post_id: run.deck[5], lap: 0 });
      // 発行済みの手番（今は非公開になった d0）はそのまま遊べる
      expect(await sessionOf(issued.session_id)).toMatchObject({ postId: d0, state: "open" });
    });

    it("R-mo.A3-2 飛ばした位置も周回に数える: 山札の残りが 1 本なら、その 1 本が毎手番 1 周ずつ速くなる", async () => {
      await seedPosts("c", 3);
      const run = await createRun();
      const keep = run.deck[1] as string;
      await restrict(run.deck[0] as string);
      await restrict(run.deck[2] as string);
      const laps = [];
      for (let i = 0; i < 6; i++) {
        const t = await next(run.run_id);
        expect(t).toMatchObject({ turn: i, post_id: keep });
        laps.push([t.lap, t.speed]);
      }
      expect(laps).toEqual([
        [0, 1],
        [1, 1.125],
        [2, 1.25],
        [3, 1.375],
        [4, 1.5],
        [5, 1.5],
      ]);
    });

    it("R-mo.A3-2 制限が解けた投稿は、次に山札がその位置に来たときにまた出る", async () => {
      await seedPosts("c", 2);
      const run = await createRun();
      const [d0, d1] = run.deck as [string, string];
      await restrict(d0);
      expect(await next(run.run_id)).toMatchObject({ turn: 0, post_id: d1, lap: 0 });
      await db.execute(sql`update posts set indiv_restricted = false where id = ${d0}`);
      expect(await next(run.run_id)).toMatchObject({ turn: 1, post_id: d0, lap: 1 });
    });

    it("R-mo.A3-2 山札の全部が出せなくなったら {done: true}（手番を発行しない）", async () => {
      await seedPosts("c", 3);
      const run = await createRun();
      await next(run.run_id);
      for (const id of run.deck) await restrict(id);
      await expectDone(run.run_id);
      expect(await sessionRows()).toHaveLength(1);
    });

    it("R-mo.A3-2 全部出せずに done を返した呼び出しは位置を進めない: 何回呼んでも、制限が解けた後の手番の周回と速度は変わらない（#143 の 4）", async () => {
      await seedPosts("c", 3);
      const run = await createRun();
      const d1 = run.deck[1] as string;
      await next(run.run_id);
      for (const id of run.deck) await restrict(id);
      for (let i = 0; i < 4; i++) await expectDone(run.run_id);
      expect((await db.select().from(s.runs).where(eq(s.runs.id, run.run_id)))[0]?.cursor).toBe(1);
      await db.execute(sql`update posts set indiv_restricted = false where id = ${d1}`);
      expect(await next(run.run_id)).toMatchObject({ turn: 1, post_id: d1, lap: 0, speed: 1 });
      // 残りの位置（山札の 3 本目）と次の周の 1 本目は制限中のまま飛ばされ、周回に数えられる
      expect(await next(run.run_id)).toMatchObject({ turn: 2, post_id: d1, lap: 1 });
    });
  });

  // ---- セッションに写す値（dm#A.3） -------------------------------------------------

  describe("セッションに写す値", () => {
    it("R-run.A3-1 投稿者本人の手番は author = true、ほかの主体は false（分布に入れない印。sc#A.4）", async () => {
      const me = await login("me@example.test");
      await seedPost("mine", { userId: me.id });
      await seedPost("theirs");
      const run = await createRun({ cookie: me.cookie });
      for (let i = 0; i < 2; i++) {
        const t = await next(run.run_id, { cookie: me.cookie });
        expect((await sessionOf(t.session_id))?.author).toBe(t.post_id === "mine");
      }
      // 匿名の主体では author にならない
      const other = await createRun({ device: DEVICE_B });
      for (let i = 0; i < 2; i++) {
        const t = await next(other.run_id, { device: DEVICE_B });
        expect((await sessionOf(t.session_id))?.author).toBe(false);
      }
    });

    it("R-run.A3-1 device_kind は発行時の User-Agent から決める（dm#A.3）", async () => {
      await seedPosts("c", 3);
      const run = await createRun();
      const uas: [string, "ios" | "android" | "other"][] = [
        [
          "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
          "ios",
        ],
        [
          "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
          "android",
        ],
        [
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
          "other",
        ],
      ];
      for (const [userAgent, kind] of uas) {
        const t = await next(run.run_id, { userAgent });
        expect((await sessionOf(t.session_id))?.deviceKind).toBe(kind);
      }
    });
  });

  // ---- 異常 ---------------------------------------------------------------------

  describe("不正な呼び出し", () => {
    it("R-run.A3-1 X-Device-Id が無い・形式外なら 400 invalid_device", async () => {
      await seedPosts("c", 3);
      const run = await createRun();
      await expectError(await postNext(run.run_id, { device: null }), 400, "invalid_device");
      await expectError(await postNext(run.run_id, { device: "short" }), 400, "invalid_device");
      expect(await sessionRows()).toEqual([]);
    });

    it("R-run.A3-1 無いランと、ほかの主体のランは区別せず 404 run_not_found", async () => {
      await seedPosts("c", 3);
      const run = await createRun({ device: DEVICE_A });
      await expectError(await postNext("01M782MV00TMYMTHTGG5C6KS3T"), 404, "run_not_found");
      await expectError(await postNext(run.run_id, { device: DEVICE_B }), 404, "run_not_found");
      expect(await sessionRows()).toEqual([]);
    });

    it("POST 以外は受けない", async () => {
      await seedPosts("c", 3);
      const run = await createRun();
      const res = await app.request(`/api/runs/${run.run_id}/next`, {
        headers: { [DEVICE_ID_HEADER]: DEVICE_A },
      });
      expect(res.status).toBe(404);
    });
  });
});
