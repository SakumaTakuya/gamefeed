/**
 * `PUT /api/sessions/{id}/result`（結果の受理）の integration テスト。
 * sc#A.2 / A.4 / A.5 / A.7、run#A.7、mo#A.2、dm#A.5 I7・I15。
 * R-sc.A2-1、R-sc.A4-1、R-sc.A7-1、R-run.A7-1（サーバ側）、R-12.2-7（I7）、R-dm.A5-15（受理の部分）、R-mo.A2-3。
 * Postgres と Better Auth は本物。時計はテストが進める。手番は `POST /api/runs` と `next` で本当に発行する。
 * 応答のステータスや拒否したセッションの状態など仕様に未記載の点は #145 の案。
 */
import { gunzipSync } from "node:zlib";
import { CALIBRATION_MIN_PLAYS, deviation, missBelow } from "@gamefeed/domain";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEVICE_ID_HEADER } from "../../src/actors.ts";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので result の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const START = Date.UTC(2026, 10, 14, 3, 0, 0);
const DEVICE_A = "0123456789abcdef0123456789abcdef";
const DURATION_FRAMES = 300;
const TARGET = 12;
/** n 番目の端末（主体） */
const device = (n: number): string => `device-${String(n).padStart(25, "0")}`;

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

/** 校正済みのゲームの分布（昇順、20 件） */
const DIST = Array.from({ length: CALIBRATION_MIN_PLAYS }, (_, i) => (i + 1) * 10);

interface Turn {
  turn: number;
  post_id: string;
  session_id: string;
  speed: number;
  is_new: boolean;
  miss_below: number | null;
}
interface Accepted {
  deviation: number | null;
  miss: boolean;
  calibration: string;
  ratio: number | null;
}

dbSuite("PUT /api/sessions/{id}/result（sc#A.2）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let login: (email: string) => Promise<{ id: string; cookie: string }>;
  let nowMs: number;
  /** R2 の代わり。key → gzip 済みの本文 */
  let replays: Map<string, Uint8Array>;
  let replayFails: boolean;

  beforeAll(async () => {
    // 同時の提出を本当に並行させるため、接続は複数にする
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
    nowMs = START;
    replays = new Map();
    replayFails = false;
    const auth = createAuth({
      baseURL: BASE,
      secret: "test-secret-".repeat(4),
      db,
      extraPlugins: [testUtils()],
    });
    app = createApp({
      auth,
      baseURL: BASE,
      publish: { db, appOrigin: BASE, now: () => new Date(nowMs) },
      random: rng(1),
      replays: {
        async putReplay(key, gz) {
          if (replayFails) throw new Error("R2 に書けない");
          replays.set(key, gz);
        },
      },
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
        target: TARGET,
        deterministic: true,
        warnings: [],
      },
    });
  });

  // ---- fixtures -----------------------------------------------------------------

  interface PostOpts {
    calibration?: "uncalibrated" | "calibrated";
    status?: "public" | "limited";
    userId?: string;
  }
  /** 投稿を 1 本だけ置く。山札はこの 1 本になり、手番 0 が等速、手番 1 以降は周回で速くなる */
  async function seedPost(o: PostOpts = {}): Promise<string> {
    const id = "post-1";
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
      sql`update posts set base_status = ${o.status ?? "public"}::base_status, published_at = now() where id = ${id}`,
    );
    if (calibration === "calibrated") await setDist(DIST);
    return id;
  }
  async function setDist(dist: number[]): Promise<void> {
    const scores = [...dist].sort((a, b) => a - b);
    await db
      .insert(s.postStats)
      .values({ postId: "post-1", n: scores.length, scores })
      .onConflictDoUpdate({ target: s.postStats.postId, set: { n: scores.length, scores } });
  }

  interface Req {
    device?: string | null;
    cookie?: string;
  }
  function headers(o: Req): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const d = o.device === undefined ? DEVICE_A : o.device;
    if (d !== null) h[DEVICE_ID_HEADER] = d;
    if (o.cookie) h.cookie = o.cookie;
    return h;
  }
  async function createRun(o: Req = {}): Promise<string> {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: headers(o),
      body: JSON.stringify({ mode: "endless" }),
    });
    const body = (await res.json()) as { run_id: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body.run_id;
  }
  async function next(runId: string, o: Req = {}): Promise<Turn> {
    const res = await app.request(`/api/runs/${runId}/next`, {
      method: "POST",
      headers: headers(o),
    });
    const body = (await res.json()) as Turn;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body, "done ではなく手番が返る").toHaveProperty("session_id");
    return body;
  }
  /** 新しいランの手番 0（等速）を発行する */
  const issue = async (o: Req = {}): Promise<Turn> => next(await createRun(o), o);

  /** 通る結果。300 フレームを遊び切った */
  const result = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    score: 55,
    frames: DURATION_FRAMES,
    via: "guest",
    inputs: [
      [30, "tap", 0.5, 0.5],
      [120, "tap", 0.25, 0.75],
    ],
    ...over,
  });
  const put = (sessionId: string, body: unknown, o: Req = {}) =>
    app.request(`/api/sessions/${sessionId}/result`, {
      method: "PUT",
      headers: headers(o),
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  /** 発行から sec 秒後に結果を送る */
  async function submit(turn: Turn, body: unknown, o: Req = {}, sec = 10): Promise<Response> {
    nowMs += sec * 1000;
    return put(turn.session_id, body, o);
  }
  async function accepted(turn: Turn, body: unknown, o: Req = {}): Promise<Accepted> {
    const res = await submit(turn, body, o);
    const json = (await res.json()) as Accepted;
    expect(res.status, JSON.stringify(json)).toBe(200);
    return json;
  }
  /** 別々の主体（端末 from〜）が、それぞれ新しいランの手番 0 で scores を 1 件ずつ記録する */
  async function playAll(scores: number[], from = 100): Promise<Accepted[]> {
    const out: Accepted[] = [];
    for (const [i, score] of scores.entries()) {
      const o = { device: device(from + i) };
      out.push(await accepted(await issue(o), result({ score }), o));
    }
    return out;
  }
  async function expectError(
    res: Response,
    status: number,
    error: Record<string, unknown>,
  ): Promise<void> {
    expect(await res.json()).toEqual(error);
    expect(res.status).toBe(status);
  }
  const sessionOf = async (id: string) =>
    (await db.select().from(s.sessions).where(eq(s.sessions.id, id)))[0];
  const stats = async (): Promise<number[] | undefined> => {
    const [row] = await db.select().from(s.postStats);
    if (row) expect(row.n, "n は scores の長さ").toBe(row.scores.length);
    return row?.scores;
  };
  const postOf = async () => (await db.select().from(s.posts))[0];

  // ---- 受理 ----------------------------------------------------------------------

  describe("受理と応答", () => {
    it("R-sc.A2-1 校正済みのゲーム: 200 で {deviation, miss, calibration, ratio} を返し、セッションは submitted / provisional になる", async () => {
      await seedPost();
      const turn = await issue();
      expect(turn.miss_below).toBe(missBelow(DIST));
      const res = await submit(turn, result({ score: 55 }));
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      // 偏差値は受理時点の分布（自分の結果を含めない 20 件）に対して出す（sc#A.5）
      expect(body).toEqual({
        deviation: deviation(55, DIST),
        miss: false,
        calibration: "calibrated",
        ratio: null,
      });

      const row = await sessionOf(turn.session_id);
      expect(row).toMatchObject({
        state: "submitted",
        via: "guest",
        score: 55,
        frames: DURATION_FRAMES,
        verdict: "provisional",
        deviation: deviation(55, DIST).toFixed(1),
      });
      expect(row?.submittedAt?.getTime()).toBe(START + 10_000);
      // 分布には受理のトランザクションで入る（昇順のまま）
      expect(await stats()).toEqual([...DIST, 55].sort((a, b) => a - b));
    });

    it("R-run.A7-1 サーバは発行時に凍結した miss_below で判定し直す。発行後に分布が動いても変わらない", async () => {
      await seedPost();
      const below = await issue({ device: device(1) });
      const at = await issue({ device: device(2) });
      const threshold = missBelow(DIST);
      expect(below.miss_below).toBe(threshold);
      expect(at.miss_below).toBe(threshold);
      // 発行の後に分布が大きく上がる。いまの分布なら threshold 点は偏差値 40 未満
      const high = DIST.map((v) => v + 1000);
      await setDist(high);
      const missed = await accepted(below, result({ score: threshold - 1 }), { device: device(1) });
      expect(missed.miss).toBe(true);
      await setDist(high);
      const r = await accepted(at, result({ score: threshold }), { device: device(2) });
      expect(r.miss).toBe(false);
      expect(r.deviation).toBe(deviation(threshold, high));
      expect(r.deviation).toBeLessThan(40);
    });

    it("R-sc.A2-1 timeout / error は score 0 として受理し、偏差値も比も出さずミスにもならない（skip）", async () => {
      await seedPost();
      for (const [i, via] of ["timeout", "error"].entries()) {
        const o = { device: device(i) };
        const turn = await issue(o);
        expect(await accepted(turn, result({ via, score: 0, inputs: [] }), o)).toEqual({
          deviation: null,
          miss: false,
          calibration: "calibrated",
          ratio: null,
        });
        expect(await sessionOf(turn.session_id)).toMatchObject({
          state: "submitted",
          via,
          score: 0,
        });
      }
      // ゲームの記録としては 0 で分布に入る（sc#A.4、B.7）
      expect(await stats()).toEqual([0, 0, ...DIST]);
    });

    it("R-sc.A2-1 校正中のゲーム: deviation は null で ratio = min(1, score / target)", async () => {
      await seedPost({ calibration: "uncalibrated" });
      const [half, over] = await playAll([6, 30]);
      expect(half).toEqual({
        deviation: null,
        miss: false,
        calibration: "uncalibrated",
        ratio: 0.5,
      });
      expect(over?.ratio).toBe(1);
      expect(await stats()).toEqual([6, 30]);
    });

    it("R-sc.A2-1 2 回目以降の提出は常に 409 で、記録も分布も変わらない", async () => {
      await seedPost();
      const turn = await issue();
      await accepted(turn, result({ score: 55 }));
      const before = await sessionOf(turn.session_id);
      for (const body of [result({ score: 55 }), result({ score: 999 }), { skipped: true }]) {
        await expectError(await submit(turn, body), 409, { error: "session_not_open" });
      }
      expect(await sessionOf(turn.session_id)).toEqual(before);
      expect(await stats()).toHaveLength(DIST.length + 1);
    });

    it("R-12.2-7 同じセッションに同時に送っても受理は 1 回（I7）", async () => {
      await seedPost();
      const turn = await issue();
      nowMs += 10_000;
      const responses = await Promise.all(
        [50, 60, 70, 80].map((score) => put(turn.session_id, result({ score }))),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect(await stats()).toHaveLength(DIST.length + 1);
    });

    it("R-sc.A2-1 {skipped: true} は open のセッションを skipped にし、点数も分布も触らない。2 回目は 409（#136）", async () => {
      await seedPost();
      const turn = await issue();
      const res = await submit(turn, { skipped: true }, {}, 1);
      expect(await res.json()).toEqual({ skipped: true });
      expect(res.status).toBe(200);
      expect(await sessionOf(turn.session_id)).toMatchObject({
        state: "skipped",
        via: null,
        score: null,
        frames: null,
        verdict: "provisional",
        submittedAt: null,
      });
      expect(await stats()).toEqual(DIST);
      await expectError(await submit(turn, { skipped: true }), 409, { error: "session_not_open" });
      await expectError(await submit(turn, result()), 409, { error: "session_not_open" });
    });
  });

  // ---- 入力ログ ------------------------------------------------------------------

  describe("入力ログの保存（dm#A.6）", () => {
    const readReplay = (key: string): unknown =>
      JSON.parse(gunzipSync(replays.get(key) as Uint8Array).toString("utf8"));

    it("受理した結果の入力ログを replays/{session_id}.json.gz に seed・speed と一緒に置き、log_key を入れる", async () => {
      await seedPost();
      const turn = await issue();
      const body = result();
      await accepted(turn, body);
      const key = `replays/${turn.session_id}.json.gz`;
      expect([...replays.keys()]).toEqual([key]);
      const row = await sessionOf(turn.session_id);
      expect(row?.logKey).toBe(key);
      expect(readReplay(key)).toEqual({ seed: row?.seed, speed: 1, inputs: body.inputs });
    });

    it("拒否した結果・読み込みの skip・409 では何も置かない", async () => {
      await seedPost();
      const rejected = await issue({ device: device(1) });
      await submit(rejected, result({ frames: 301 }), { device: device(1) });
      const skipped = await issue({ device: device(2) });
      await submit(skipped, { skipped: true }, { device: device(2) });
      await submit(skipped, result(), { device: device(2) });
      expect(replays.size).toBe(0);
      expect((await sessionOf(rejected.session_id))?.logKey).toBeNull();
      expect((await sessionOf(skipped.session_id))?.logKey).toBeNull();
    });

    it("R2 に書けなくても結果は受理され、log_key は NULL のまま残る", async () => {
      await seedPost();
      replayFails = true;
      const turn = await issue();
      await accepted(turn, result());
      expect(await sessionOf(turn.session_id)).toMatchObject({ state: "submitted", logKey: null });
    });

    it("置き場が未設定（R2_* なし）でも結果は受理され、log_key は NULL", async () => {
      await seedPost();
      const turn = await issue();
      const bare = createApp({
        auth: createAuth({ baseURL: BASE, secret: "test-secret-".repeat(4), db }),
        baseURL: BASE,
        publish: { db, appOrigin: BASE, now: () => new Date(nowMs) },
      });
      nowMs += 10_000;
      const res = await bare.request(`/api/sessions/${turn.session_id}/result`, {
        method: "PUT",
        headers: headers({}),
        body: JSON.stringify(result()),
      });
      expect(res.status).toBe(200);
      expect(await sessionOf(turn.session_id)).toMatchObject({ state: "submitted", logKey: null });
    });
  });

  // ---- 拒否 ----------------------------------------------------------------------

  describe("拒否（このセッションは無効）", () => {
    const cases: {
      name: string;
      reason: string;
      flagged: boolean;
      body: Record<string, unknown>;
      sec?: number;
    }[] = [
      { name: "発行から 30 分を過ぎた", reason: "expired", flagged: false, body: {}, sec: 1801 },
      { name: "score が負", reason: "score", flagged: false, body: { score: -1 } },
      {
        name: "frames が time_limit 超過",
        reason: "frames",
        flagged: false,
        body: { frames: 301 },
      },
      {
        name: "入力ログの frame が減る",
        reason: "inputs",
        flagged: true,
        body: {
          inputs: [
            [50, "tap", 0.5, 0.5],
            [49, "tap", 0.5, 0.5],
          ],
        },
      },
      {
        name: "入力ログの最大 frame が frames 超過",
        reason: "inputs",
        flagged: true,
        body: { frames: 280, inputs: [[281, "tap", 0.5, 0.5]] },
      },
      // 300 フレーム等速は 5 秒。発行の 1 秒後では 1.05 + 3 = 4.05 秒ぶんしか遊べない
      { name: "実時間より多いフレーム", reason: "realtime", flagged: true, body: {}, sec: 1 },
      { name: "via が不明", reason: "via", flagged: false, body: { via: "host" } },
      {
        name: "timeout なのに score > 0",
        reason: "via",
        flagged: false,
        body: { via: "timeout", score: 5 },
      },
    ];
    for (const c of cases) {
      it(`R-sc.A2-1 ${c.name} → 422 invalid_result（${c.reason}）。セッションは skipped${c.flagged ? " / flagged" : ""} で、分布に入らない`, async () => {
        await seedPost();
        const turn = await issue();
        const res = await submit(turn, result(c.body), {}, c.sec ?? 10);
        await expectError(res, 422, { error: "invalid_result", reason: c.reason });
        expect(await sessionOf(turn.session_id)).toMatchObject({
          state: "skipped",
          verdict: c.flagged ? "flagged" : "provisional",
          via: null,
          score: null,
          frames: null,
          deviation: null,
          submittedAt: null,
        });
        expect(await stats()).toEqual(DIST);
        // 拒否されたセッションに正しい結果を送り直しても 409
        nowMs = START + 10_000;
        await expectError(await put(turn.session_id, result()), 409, { error: "session_not_open" });
      });
    }

    it("R-sc.A2-1 境界: 30 分ちょうど・frames = time_limit・入力の frame = frames は受理", async () => {
      await seedPost();
      const turn = await issue();
      const res = await submit(
        turn,
        result({ inputs: [[DURATION_FRAMES, "tap", 0, 0]] }),
        {},
        1800,
      );
      expect(res.status).toBe(200);
    });

    it("主体が違う・セッションが無いと 404 session_not_found、X-Device-Id が無いと 400、本文が JSON のオブジェクトでないと 400（セッションは open のまま）", async () => {
      await seedPost();
      const turn = await issue();
      nowMs += 10_000;
      await expectError(await put(turn.session_id, result(), { device: device(9) }), 404, {
        error: "session_not_found",
      });
      await expectError(await put("01JCXXXXXXXXXXXXXXXXXXXXXX", result()), 404, {
        error: "session_not_found",
      });
      await expectError(await put(turn.session_id, result(), { device: null }), 400, {
        error: "invalid_device",
      });
      for (const body of ["{", "null", "[1]", '"x"']) {
        await expectError(await put(turn.session_id, body), 400, { error: "invalid_request" });
      }
      expect(await sessionOf(turn.session_id)).toMatchObject({ state: "open" });
      expect((await put(turn.session_id, result())).status).toBe(200);
    });
  });

  // ---- 分布 ----------------------------------------------------------------------

  describe("分布に入る結果（sc#A.4、I15）", () => {
    it("R-sc.A4-1 speed > 1.0 の結果は分布に入らないが、等速の分布に対する偏差値は出る", async () => {
      await seedPost();
      const run = await createRun();
      await next(run);
      const fast = await next(run);
      expect(fast.speed).toBe(1.125);
      const r = await accepted(fast, result({ score: 55 }));
      expect(r.deviation).toBe(deviation(55, DIST));
      expect(await stats()).toEqual(DIST);
    });

    it("R-sc.A4-1 作者本人の結果は保存するが分布に入らない", async () => {
      const me = await login("maker@example.test");
      await seedPost({ userId: me.id });
      const o = { cookie: me.cookie };
      const turn = await issue(o);
      const r = await accepted(turn, result({ score: 55 }), o);
      expect(r.deviation).toBe(deviation(55, DIST));
      expect(await sessionOf(turn.session_id)).toMatchObject({ author: true, state: "submitted" });
      expect(await stats()).toEqual(DIST);
    });

    it("R-sc.A4-1 短縮されたセッション（frames < 0.9 × time_limit）は入らず、9 割ちょうどは入る", async () => {
      await seedPost();
      const short = await accepted(
        await issue({ device: device(1) }),
        result({ score: 55, frames: 269 }),
        { device: device(1) },
      );
      // 本人の偏差値は出す（sc#B.6）
      expect(short.deviation).toBe(deviation(55, DIST));
      expect(await stats()).toEqual(DIST);
      await accepted(await issue({ device: device(2) }), result({ score: 55, frames: 270 }), {
        device: device(2),
      });
      expect(await stats()).toHaveLength(DIST.length + 1);
    });

    it("R-sc.A4-1 R-dm.A5-15 1 主体 1 ゲームにつき直近 5 件まで。6 件目で最古が外れ、n は増えない", async () => {
      await seedPost();
      for (const score of [1, 2, 3, 4, 5]) await accepted(await issue(), result({ score }));
      expect(await stats()).toEqual([1, 2, 3, 4, 5, ...DIST]);
      await accepted(await issue(), result({ score: 6 }));
      expect(await stats()).toEqual([2, 3, 4, 5, 6, ...DIST]);
      await accepted(await issue(), result({ score: 7 }));
      expect(await stats()).toEqual([3, 4, 5, 6, 7, ...DIST]);
      // 窓は主体ごと。ほかの主体の結果は押し出さない
      await accepted(await issue({ device: device(1) }), result({ score: 8 }), {
        device: device(1),
      });
      expect(await stats()).toEqual([3, 4, 5, 6, 7, 8, ...DIST]);
    });

    it("R-sc.A4-1 窓は分布に入った結果だけで数える（分布に入らない結果は直近 5 件を押し出さない）", async () => {
      await seedPost();
      for (const score of [1, 2, 3, 4, 5]) await accepted(await issue(), result({ score }));
      // 短縮された結果を挟んでも、分布の 5 件はそのまま
      await accepted(await issue(), result({ score: 99, frames: 100, inputs: [] }));
      expect(await stats()).toEqual([1, 2, 3, 4, 5, ...DIST]);
    });

    it("R-dm.A5-15 別々の主体が同じゲームへ同時に送っても、分布の更新は失われない", async () => {
      await seedPost();
      const turns: { turn: Turn; o: Req }[] = [];
      for (let i = 0; i < 8; i++) {
        const o = { device: device(i) };
        turns.push({ turn: await issue(o), o });
      }
      nowMs += 10_000;
      const responses = await Promise.all(
        turns.map(({ turn, o }, i) => put(turn.session_id, result({ score: 300 + i }), o)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await stats()).toEqual([...DIST, 300, 301, 302, 303, 304, 305, 306, 307]);
    });
  });

  // ---- 校正 ----------------------------------------------------------------------

  describe("校正状態の遷移（sc#A.7）", () => {
    const spread = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

    it("R-sc.A7-1 19 件目では uncalibrated のまま、20 件目で calibrated になる", async () => {
      await seedPost({ calibration: "uncalibrated" });
      const first = await playAll(spread(19));
      expect(first.map((r) => r.calibration)).toEqual(Array(19).fill("uncalibrated"));
      expect((await postOf())?.calibration).toBe("uncalibrated");

      const [twentieth] = await playAll([20], 200);
      // この手番は新作扱いで発行されたので、校正済みになった結果でも偏差値ではなく比を出す
      expect(twentieth).toEqual({
        deviation: null,
        miss: false,
        calibration: "calibrated",
        ratio: 1,
      });
      expect((await postOf())?.calibration).toBe("calibrated");
      expect(await stats()).toEqual(spread(20));
    });

    it("R-sc.A7-1 分布に入らない結果は校正の件数に数えない", async () => {
      await seedPost({ calibration: "uncalibrated" });
      await playAll(spread(19));
      const o = { device: device(300) };
      await accepted(await issue(o), result({ score: 9, frames: 100, inputs: [] }), o);
      expect((await postOf())?.calibration).toBe("uncalibrated");
    });

    it("R-sc.A7-1 20 件目で全件同じ点（分散ゼロ）なら invalid", async () => {
      await seedPost({ calibration: "uncalibrated" });
      const all = await playAll(Array(20).fill(7));
      expect(all[18]?.calibration).toBe("uncalibrated");
      expect(all[19]?.calibration).toBe("invalid");
      expect((await postOf())?.calibration).toBe("invalid");
    });

    it("R-sc.A7-1 20 件目で 0 の割合が 80% 以上（0 張り付き）なら invalid", async () => {
      await seedPost({ calibration: "uncalibrated" });
      const all = await playAll([...Array(16).fill(0), 1, 2, 3, 4]);
      expect(all[19]?.calibration).toBe("invalid");
      expect((await postOf())?.calibration).toBe("invalid");
    });

    it("R-sc.A7-1 invalid は終端。その後に点のばらついた結果が来ても戻らない", async () => {
      await seedPost({ calibration: "uncalibrated" });
      // invalid になると手番を発行できないので、先に発行しておく
      const late: { turn: Turn; o: Req }[] = [];
      for (let i = 0; i < 6; i++) {
        const o = { device: device(500 + i) };
        late.push({ turn: await issue(o), o });
      }
      await playAll(Array(20).fill(7));
      expect((await postOf())?.calibration).toBe("invalid");
      for (const [i, { turn, o }] of late.entries()) {
        const r = await accepted(turn, result({ score: 100 + i }), o);
        expect(r.calibration).toBe("invalid");
      }
      expect((await postOf())?.calibration).toBe("invalid");
      expect(await stats()).toHaveLength(26);
    });

    it("R-sc.A7-1 校正済みのゲームは、その後の結果で全件同じ点になっても calibrated のまま", async () => {
      await seedPost();
      await setDist(Array(20).fill(7));
      const r = await accepted(await issue(), result({ score: 7 }));
      expect(r.calibration).toBe("calibrated");
      expect((await postOf())?.calibration).toBe("calibrated");
    });

    it("R-mo.A2-3 limited の投稿は calibrated になる遷移で public に昇格する", async () => {
      await seedPost({ calibration: "uncalibrated", status: "limited" });
      await playAll(spread(19));
      expect((await postOf())?.baseStatus).toBe("limited");
      await playAll([20], 200);
      expect(await postOf()).toMatchObject({ calibration: "calibrated", baseStatus: "public" });
    });

    it("R-mo.A2-3 制限中、または upheld の通報がある投稿は校正済みになっても昇格しない", async () => {
      for (const block of ["indiv_restricted", "tree_lock", "upheld"] as const) {
        await db.execute(
          sql`truncate table sessions, runs, reports, post_stats, tree_locks, moderation_actions, actors, posts cascade`,
        );
        await seedPost({ calibration: "uncalibrated", status: "limited" });
        await playAll(spread(19));
        // 20 件目の手番を発行してから制限する（制限中は発行されない）
        const o = { device: device(200) };
        const turn = await issue(o);
        if (block === "indiv_restricted") {
          await db.execute(sql`update posts set indiv_restricted = true`);
        } else if (block === "tree_lock") {
          const [action] = await db
            .insert(s.moderationActions)
            .values({ kind: "restrict_tree", postId: "post-1", reason: "test" })
            .returning();
          await db
            .insert(s.treeLocks)
            .values({ rootPostId: "post-1", actionId: action?.id as number });
        } else {
          const [actor] = await db.select().from(s.actors).limit(1);
          await db.insert(s.reports).values({
            postId: "post-1",
            actorId: actor?.id as string,
            category: "other",
            weight: 0,
            resolution: "upheld",
          });
        }
        const r = await accepted(turn, result({ score: 20 }), o);
        expect(r.calibration, block).toBe("calibrated");
        expect(await postOf(), block).toMatchObject({
          calibration: "calibrated",
          baseStatus: "limited",
        });
      }
    });

    it("R-mo.A2-3 invalid になった limited の投稿は昇格しない", async () => {
      await seedPost({ calibration: "uncalibrated", status: "limited" });
      await playAll(Array(20).fill(7));
      expect(await postOf()).toMatchObject({ calibration: "invalid", baseStatus: "limited" });
    });
  });
});
