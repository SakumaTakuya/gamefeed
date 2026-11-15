/**
 * `POST /api/runs/{id}/finish`（ランを閉じ、成績表を凍結する）の integration テスト。
 * run#A.3 / A.7 / A.11、sc#A.9、dm#A.5 I13。R-run.A7-2（integration）、R-sc.A9-1、R-sc.A2-1（skip の後の finish）。
 * Postgres と Better Auth は本物。時計はテストが進める。手番と結果は `next` と `result` で本当に作る。
 * 応答の形や 2 回目の finish など仕様に未記載の点は #147 の案。
 */
import { CALIBRATION_MIN_PLAYS, deviation, ENDLESS_TURN_LIMIT, missBelow } from "@gamefeed/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEVICE_ID_HEADER } from "../../src/actors.ts";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので finish の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const START = Date.UTC(2026, 10, 15, 3, 0, 0);
const DEVICE_A = "0123456789abcdef0123456789abcdef";
const DURATION_FRAMES = 300;
const TARGET = 12;
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
const THRESHOLD = missBelow(DIST);
/** ミスになる点と、ならない点 */
const LOW = THRESHOLD - 1;
const HIGH = 155;

interface Turn {
  turn: number;
  post_id: string;
  session_id: string;
  speed: number;
  is_new: boolean;
  miss_below: number | null;
}
interface ReportTurn {
  turn: number;
  post_id: string;
  kind: "ok" | "miss" | "skip";
  deviation: number | null;
  ratio: number | null;
  is_new: boolean;
  speed: number;
}
interface Report {
  run_id: string;
  mode: string;
  ended: "lives" | "limit" | "abandoned";
  reached: number;
  avg_deviation: number | null;
  symbols: string | null;
  turns: ReportTurn[];
}

dbSuite("POST /api/runs/{id}/finish（run#A.3、sc#A.9）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let nowMs: number;

  beforeAll(async () => {
    const h = createDb(url as string, { max: 4 });
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
      sql`truncate table sessions, runs, reports, likes, post_stats, tree_locks, moderation_actions, actors, posts, games, users, auth_user cascade`,
    );
    nowMs = START;
    app = createApp({
      auth: createAuth({ baseURL: BASE, secret: "test-secret-".repeat(4), db }),
      baseURL: BASE,
      publish: { db, appOrigin: BASE, now: () => new Date(nowMs) },
      random: rng(1),
    });
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

  async function seedPost(id: string, calibration: "uncalibrated" | "calibrated"): Promise<void> {
    await db.insert(s.posts).values({
      id,
      userId: "author",
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
    if (calibration === "calibrated") {
      await db.insert(s.postStats).values({ postId: id, n: DIST.length, scores: DIST });
    }
  }
  /** 校正済み n 本。12 本なら山札は 12 本で新作枠なし */
  const seedCalibrated = (n = 12) =>
    Promise.all(Array.from({ length: n }, (_, i) => seedPost(`c${i}`, "calibrated")));

  interface Req {
    device?: string | null;
  }
  function headers(o: Req): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const d = o.device === undefined ? DEVICE_A : o.device;
    if (d !== null) h[DEVICE_ID_HEADER] = d;
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
  const postNext = (runId: string, o: Req = {}) =>
    app.request(`/api/runs/${runId}/next`, { method: "POST", headers: headers(o) });
  async function next(runId: string, o: Req = {}): Promise<Turn> {
    const res = await postNext(runId, o);
    const body = (await res.json()) as Turn;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body, "done ではなく手番が返る").toHaveProperty("session_id");
    return body;
  }
  const issueMany = async (runId: string, n: number, o: Req = {}): Promise<Turn[]> => {
    const out: Turn[] = [];
    for (let i = 0; i < n; i++) out.push(await next(runId, o));
    return out;
  };
  /** 10 秒後に結果を送る */
  async function put(turn: Turn, body: unknown, o: Req = {}): Promise<Response> {
    nowMs += 10_000;
    return app.request(`/api/sessions/${turn.session_id}/result`, {
      method: "PUT",
      headers: headers(o),
      body: JSON.stringify(body),
    });
  }
  async function play(turn: Turn, score: number, o: Req = {}): Promise<void> {
    const res = await put(turn, { score, frames: DURATION_FRAMES, via: "guest", inputs: [] }, o);
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const postFinish = (runId: string, o: Req = {}) =>
    app.request(`/api/runs/${runId}/finish`, { method: "POST", headers: headers(o) });
  async function finish(runId: string, o: Req = {}): Promise<Report> {
    const res = await postFinish(runId, o);
    const body = (await res.json()) as Report;
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body;
  }
  const runRow = async (id: string) => (await db.select().from(s.runs).where(eq(s.runs.id, id)))[0];
  const states = async (runId: string) =>
    (
      await db.select().from(s.sessions).where(eq(s.sessions.runId, runId)).orderBy(s.sessions.turn)
    ).map((r) => r.state);
  const dev = (score: number) => deviation(score, DIST);

  // ---- 成績表 --------------------------------------------------------------------

  describe("成績表の凍結", () => {
    it("R-sc.A9-1 途中でやめたラン: 遊んだ手番の偏差値・到達本数・平均偏差値を返し、runs に保存する", async () => {
      await seedCalibrated();
      const run = await createRun();
      const turns = await issueMany(run, 3);
      await play(turns[0] as Turn, HIGH);
      await play(turns[1] as Turn, 95);
      await play(turns[2] as Turn, LOW);
      nowMs += 5_000;
      const res = await postFinish(run);
      const report = (await res.json()) as Report;
      expect(res.status, JSON.stringify(report)).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const avg = Math.round((dev(HIGH) * 10 + dev(95) * 10 + dev(LOW) * 10) / 3) / 10;
      expect(report).toEqual({
        run_id: run,
        mode: "endless",
        ended: "abandoned",
        reached: 3,
        avg_deviation: avg,
        symbols: null,
        turns: [
          {
            turn: 0,
            post_id: turns[0]?.post_id,
            kind: "ok",
            deviation: dev(HIGH),
            ratio: null,
            is_new: false,
            speed: 1,
          },
          {
            turn: 1,
            post_id: turns[1]?.post_id,
            kind: "ok",
            deviation: dev(95),
            ratio: null,
            is_new: false,
            speed: 1,
          },
          {
            turn: 2,
            post_id: turns[2]?.post_id,
            kind: "miss",
            deviation: dev(LOW),
            ratio: null,
            is_new: false,
            speed: 1,
          },
        ],
      });
      const row = await runRow(run);
      expect(row).toMatchObject({
        reached: 3,
        avgDeviation: avg.toFixed(1),
        symbols: null,
        ended: "abandoned",
      });
      expect(row?.endedAt?.getTime()).toBe(nowMs);
    });

    it("R-run.A7-2 3 回目のミスの後に送った結果は到達本数に入らない（ended: lives）", async () => {
      await seedCalibrated();
      const run = await createRun();
      // 先読みで 5 手番を発行してから、3 回ミスし、その後の 2 手番も送る
      const turns = await issueMany(run, 5);
      for (const t of turns.slice(0, 3)) await play(t, LOW);
      for (const t of turns.slice(3)) await play(t, HIGH);
      const report = await finish(run);
      expect(report).toMatchObject({ ended: "lives", reached: 3 });
      expect(report.turns.map((t) => t.kind)).toEqual(["miss", "miss", "miss"]);
      // 捨てた手番の偏差値は平均に入らない
      expect(report.avg_deviation).toBe(dev(LOW));
    });

    it("R-run.A7-2 3 回目のミスの結果を送らずに次を送っても、その手番はミスに数える", async () => {
      await seedCalibrated();
      const run = await createRun();
      const turns = await issueMany(run, 4);
      await play(turns[0] as Turn, LOW);
      await play(turns[1] as Turn, LOW);
      // 手番 2 は送らない
      await play(turns[3] as Turn, HIGH);
      const report = await finish(run);
      expect(report).toMatchObject({ ended: "lives", reached: 3 });
      expect(report.turns[2]).toMatchObject({
        turn: 2,
        kind: "miss",
        deviation: null,
        ratio: null,
      });
    });

    it("R-run.A7-2 先読みで発行しただけの手番は数えず、finish で abandoned になる", async () => {
      await seedCalibrated();
      const run = await createRun();
      const turns = await issueMany(run, 4);
      await play(turns[0] as Turn, HIGH);
      await play(turns[1] as Turn, HIGH);
      expect(await states(run)).toEqual(["submitted", "submitted", "open", "open"]);
      const report = await finish(run);
      expect(report).toMatchObject({ ended: "abandoned", reached: 2 });
      expect(report.turns).toHaveLength(2);
      expect(await states(run)).toEqual(["submitted", "submitted", "abandoned", "abandoned"]);
    });

    it("R-sc.A2-1 読み込みの skip・拒否された結果・timeout は skip として数え、偏差値の平均にも残機にも入らない", async () => {
      await seedCalibrated();
      const run = await createRun();
      const turns = await issueMany(run, 5);
      await play(turns[0] as Turn, HIGH);
      expect((await put(turns[1] as Turn, { skipped: true })).status).toBe(200);
      const bad = { score: 5, frames: DURATION_FRAMES + 1, via: "guest", inputs: [] };
      expect((await put(turns[2] as Turn, bad)).status).toBe(422);
      const timeout = { score: 0, frames: DURATION_FRAMES, via: "timeout", inputs: [] };
      expect((await put(turns[3] as Turn, timeout)).status).toBe(200);
      await play(turns[4] as Turn, 95);
      const report = await finish(run);
      expect(report).toMatchObject({ ended: "abandoned", reached: 5 });
      expect(report.turns.map((t) => t.kind)).toEqual(["ok", "skip", "skip", "skip", "ok"]);
      expect(report.turns.map((t) => t.deviation)).toEqual([dev(HIGH), null, null, null, dev(95)]);
      expect(report.avg_deviation).toBe(Math.round((dev(HIGH) * 10 + dev(95) * 10) / 2) / 10);
    });

    it("R-sc.A9-1 新作扱いの手番は比を返し、平均偏差値にも残機にも入らない", async () => {
      await seedPost("new-1", "uncalibrated");
      const run = await createRun();
      const turn = await next(run);
      expect(turn).toMatchObject({ is_new: true, miss_below: null });
      await play(turn, 6);
      expect(await finish(run)).toMatchObject({
        reached: 1,
        avg_deviation: null,
        turns: [{ turn: 0, kind: "ok", deviation: null, ratio: 0.5, is_new: true }],
      });
      expect((await runRow(run))?.avgDeviation).toBeNull();
    });

    it("結果が 1 つも無いランは到達 0 本で abandoned", async () => {
      await seedCalibrated();
      const run = await createRun();
      await issueMany(run, 2);
      expect(await finish(run)).toMatchObject({
        ended: "abandoned",
        reached: 0,
        avg_deviation: null,
        turns: [],
      });
      expect(await states(run)).toEqual(["abandoned", "abandoned"]);
    });

    it("R-run.A7-2 上限の 50 手番を遊び切ると ended: limit、到達 50 本", async () => {
      await seedCalibrated();
      const run = await createRun();
      for (let i = 0; i < ENDLESS_TURN_LIMIT; i++) await play(await next(run), HIGH);
      expect(await (await postNext(run)).json()).toEqual({ done: true });
      const report = await finish(run);
      expect(report).toMatchObject({ ended: "limit", reached: ENDLESS_TURN_LIMIT });
      expect(report.turns).toHaveLength(ENDLESS_TURN_LIMIT);
      expect(report.turns[ENDLESS_TURN_LIMIT - 1]?.speed).toBe(1.5);
    }, 30_000);
  });

  // ---- 凍結と冪等 ------------------------------------------------------------------

  describe("凍結した値は変わらない（I13）", () => {
    it("R-sc.A9-1 finish の後に同じゲームへ 100 件足しても、runs の値も 2 回目の finish の応答も変わらない（S6）", async () => {
      await seedPost("c0", "calibrated");
      const run = await createRun();
      // 山札は 1 本。手番 0 が等速、手番 1 は 1.125 倍
      const turns = await issueMany(run, 2);
      await play(turns[0] as Turn, 95);
      await play(turns[1] as Turn, 45);
      const first = await finish(run);
      const before = await runRow(run);
      expect(first.turns.map((t) => t.deviation)).toEqual([
        dev(95),
        deviation(
          45,
          [...DIST, 95].sort((a, b) => a - b),
        ),
      ]);

      // ほかの 100 人が同じゲームで高い点を出す。いまの分布なら 95 点の偏差値は大きく下がる
      for (let i = 0; i < 100; i++) {
        const o = { device: device(i) };
        await play(await next(await createRun(o), o), 1000 + i, o);
      }
      const [stat] = await db.select().from(s.postStats);
      expect(stat?.n).toBe(DIST.length + 1 + 100);
      expect(deviation(95, stat?.scores ?? [])).toBeLessThan(dev(95) - 5);

      expect(await runRow(run)).toEqual(before);
      expect(await finish(run)).toEqual(first);
      expect(await runRow(run)).toEqual(before);
    }, 30_000);

    it("2 回目以降の finish は同じ成績表を返し、ended_at も変わらない。同時に呼んでも同じ", async () => {
      await seedCalibrated();
      const run = await createRun();
      const turns = await issueMany(run, 3);
      await play(turns[0] as Turn, HIGH);
      await play(turns[1] as Turn, LOW);
      const reports = await Promise.all([1, 2, 3, 4].map(() => finish(run)));
      for (const r of reports) expect(r).toEqual(reports[0]);
      const endedAt = (await runRow(run))?.endedAt;
      nowMs += 60_000;
      expect(await finish(run)).toEqual(reports[0]);
      expect((await runRow(run))?.endedAt).toEqual(endedAt);
    });

    it("受理の途中の result があれば確定を待ち、その結果を成績表に入れる", async () => {
      await seedCalibrated();
      const run = await createRun();
      const turns = await issueMany(run, 2);
      await play(turns[0] as Turn, HIGH);
      const id = turns[1]?.session_id as string;
      // result のトランザクションがセッションの行ロックを持ったまま止まっている状態を作る
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => {};
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const inFlight = db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from sessions where id = ${id} for update`);
        await tx.execute(sql`
          update sessions set state = 'submitted', via = 'guest', score = ${HIGH}, frames = ${DURATION_FRAMES},
                 deviation = 61.5, submitted_at = now()
          where id = ${id}`);
        locked();
        await held;
      });
      await lockTaken;
      const pending = finish(run);
      // finish はロックを待っている。待たずに数えると到達 1 本で確定してしまう
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await runRow(run))?.endedAt).toBeNull();
      release();
      await inFlight;
      const report = await pending;
      expect(report).toMatchObject({ reached: 2 });
      expect(report.turns[1]).toMatchObject({ turn: 1, kind: "ok", deviation: 61.5 });
      expect(await states(run)).toEqual(["submitted", "submitted"]);
    });

    it("finish の後は手番を発行せず（done）、未提出だった手番の結果は 409", async () => {
      await seedCalibrated();
      const run = await createRun();
      const turns = await issueMany(run, 2);
      await play(turns[0] as Turn, HIGH);
      const first = await finish(run);
      expect(await (await postNext(run)).json()).toEqual({ done: true });
      const late = await put(turns[1] as Turn, {
        score: HIGH,
        frames: DURATION_FRAMES,
        via: "guest",
        inputs: [],
      });
      expect(late.status).toBe(409);
      expect(await finish(run)).toEqual(first);
    });

    it("ランが無い・ほかの主体のランは 404 run_not_found、X-Device-Id が無いと 400。どちらもランを閉じない", async () => {
      await seedCalibrated();
      const run = await createRun();
      for (const [res, status, error] of [
        [await postFinish(run, { device: device(9) }), 404, "run_not_found"],
        [await postFinish("01JCXXXXXXXXXXXXXXXXXXXXXX"), 404, "run_not_found"],
        [await postFinish(run, { device: null }), 400, "invalid_device"],
      ] as const) {
        expect(await res.json()).toEqual({ error });
        expect(res.status).toBe(status);
      }
      expect((await runRow(run))?.endedAt).toBeNull();
    });
  });
});
