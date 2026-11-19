/**
 * ランの API（`POST /runs`、`PUT /runs/{id}/turns/{t}`、`finish`）の integration テストの土台。
 * Postgres と Better Auth は本物。時計はテストが進める。乱数は seed から決まる。R2 は Map。
 * `describe` の中で `useRunHarness()` を呼ぶと、`beforeAll` / `beforeEach` が登録される。
 */
import { CALIBRATION_MIN_PLAYS } from "@gamefeed/domain";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { DEVICE_ID_HEADER } from "../../src/actors.ts";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";

export const BASE = "https://app.example.test";
export const START = Date.UTC(2026, 10, 19, 3, 0, 0);
export const DEVICE_A = "0123456789abcdef0123456789abcdef";
export const DURATION_FRAMES = 300;
export const TARGET = 12;
/** n 番目の端末（主体） */
export const device = (n: number): string => `device-${String(n).padStart(25, "0")}`;
/** 校正済みのゲームの分布（昇順、20 件） */
export const DIST = Array.from({ length: CALIBRATION_MIN_PLAYS }, (_, i) => (i + 1) * 10);

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Req {
  device?: string | null;
  cookie?: string;
}
export interface Plan {
  run_id: string;
  seed: number;
  deck: { post_id: string; is_new: boolean; miss_below: number | null; time_limit: number }[];
}
export interface Settled {
  settled: number;
  deviation: number | null;
  miss: boolean;
  calibration: string;
  ratio: number | null;
}
export interface Report {
  run_id: string;
  mode: string;
  ended: string;
  reached: number;
  avg_deviation: number | null;
  symbols: string | null;
  turns: {
    turn: number;
    post_id: string;
    kind: string;
    deviation: number | null;
    ratio: number | null;
    is_new: boolean;
    speed: number;
  }[];
}
export interface PostOpts {
  id?: string;
  calibration?: "uncalibrated" | "calibrated";
  status?: "public" | "limited";
  userId?: string;
}

interface TestHelpers {
  createUser(u: { email: string; name: string }): { id: string };
  saveUser(u: { id: string }): Promise<unknown>;
  login(o: { userId: string }): Promise<{ cookies: { name: string; value: string }[] }>;
}

/** 通る遊んだ結果。300 フレームを遊び切った */
export const guest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  via: "guest",
  score: 55,
  frames: DURATION_FRAMES,
  inputs: [
    [30, "tap", 0.5, 0.5],
    [120, "tap", 0.25, 0.75],
  ],
  ...over,
});

export function headers(o: Req = {}): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const d = o.device === undefined ? DEVICE_A : o.device;
  if (d !== null) h[DEVICE_ID_HEADER] = d;
  if (o.cookie) h.cookie = o.cookie;
  return h;
}

export async function expectError(
  res: Response,
  status: number,
  error: Record<string, unknown>,
): Promise<void> {
  expect(await res.json()).toEqual(error);
  expect(res.status).toBe(status);
}

export function useRunHarness(url: string) {
  let close: (() => Promise<void>) | undefined;
  const h = {
    db: undefined as unknown as Db,
    app: undefined as unknown as ReturnType<typeof createApp>,
    /** 今の時刻（エポックミリ秒）。テストが進める */
    nowMs: START,
    /** R2 の代わり。key → gzip 済みの本文 */
    replays: new Map<string, Uint8Array>(),
    replayFails: false,
    login: undefined as unknown as (email: string) => Promise<{ id: string; cookie: string }>,

    /** 投稿を 1 本置く。既定は校正済み（分布は DIST）・公開。id の既定は post-1 */
    async seedPost(o: PostOpts = {}): Promise<string> {
      const id = o.id ?? "post-1";
      const calibration = o.calibration ?? "calibrated";
      await h.db.insert(s.posts).values({
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
      await h.db.execute(
        sql`update posts set base_status = ${o.status ?? "public"}::base_status, published_at = now() where id = ${id}`,
      );
      if (calibration === "calibrated") await h.setDist(DIST, id);
      return id;
    },
    /** 校正済みを n 本（c0, c1, …）。山札はこの n 本になる */
    async seedCalibrated(n: number): Promise<void> {
      for (let i = 0; i < n; i++) await h.seedPost({ id: `c${i}` });
    },
    async setDist(dist: number[], postId = "post-1"): Promise<void> {
      const scores = [...dist].sort((a, b) => a - b);
      await h.db
        .insert(s.postStats)
        .values({ postId, n: scores.length, scores })
        .onConflictDoUpdate({ target: s.postStats.postId, set: { n: scores.length, scores } });
    },

    postRun: (o: Req = {}, body: unknown = { mode: "endless" }) =>
      h.app.request("/api/runs", {
        method: "POST",
        headers: headers(o),
        body: JSON.stringify(body),
      }),
    async createRun(o: Req = {}): Promise<Plan> {
      const res = await h.postRun(o);
      const body = (await res.json()) as Plan;
      expect(res.status, JSON.stringify(body)).toBe(201);
      return body;
    },
    /** いまの時刻で手番 t の結果を送る */
    put: (runId: string, t: number | string, body: unknown, o: Req = {}) =>
      h.app.request(`/api/runs/${runId}/turns/${t}`, {
        method: "PUT",
        headers: headers(o),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    /** sec 秒後に手番 t の結果を送り、200 で足されたことを確かめる */
    async settle(runId: string, t: number, body: unknown, o: Req = {}, sec = 10): Promise<Settled> {
      h.nowMs += sec * 1000;
      const res = await h.put(runId, t, body, o);
      const json = (await res.json()) as Settled;
      expect(res.status, JSON.stringify(json)).toBe(200);
      return json;
    },
    /** 新しいランを作って手番 0（等速）に結果を足す */
    async playOnce(body: unknown, o: Req = {}): Promise<Settled & { runId: string }> {
      const run = await h.createRun(o);
      return { ...(await h.settle(run.run_id, 0, body, o)), runId: run.run_id };
    },
    /** 別々の主体（端末 from〜）が、それぞれ新しいランの手番 0 で結果を 1 件ずつ足す */
    async playAll(bodies: unknown[], from = 100): Promise<Settled[]> {
      const out: Settled[] = [];
      for (const [i, body] of bodies.entries()) {
        const { runId: _runId, ...settled } = await h.playOnce(body, { device: device(from + i) });
        out.push(settled);
      }
      return out;
    },
    postFinish: (runId: string, o: Req = {}) =>
      h.app.request(`/api/runs/${runId}/finish`, { method: "POST", headers: headers(o) }),
    async finish(runId: string, o: Req = {}): Promise<Report> {
      const res = await h.postFinish(runId, o);
      const body = (await res.json()) as Report;
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body;
    },

    runRow: async (id: string) => (await h.db.select().from(s.runs).where(eq(s.runs.id, id)))[0],
    /** ランの記録（sessions の行）を手番の順に */
    turnRows: (runId: string) =>
      h.db.select().from(s.sessions).where(eq(s.sessions.runId, runId)).orderBy(s.sessions.turn),
    async stats(postId = "post-1"): Promise<{ scores: number[]; failures: number } | undefined> {
      const [row] = await h.db.select().from(s.postStats).where(eq(s.postStats.postId, postId));
      if (row) expect(row.n, "n は scores の長さ").toBe(row.scores.length);
      return row && { scores: row.scores, failures: row.failures };
    },
    postOf: async (id = "post-1") =>
      (await h.db.select().from(s.posts).where(eq(s.posts.id, id)))[0],
    /** R2 なしの app（`R2_*` が未設定の環境） */
    bareApp: () =>
      createApp({
        auth: createAuth({ baseURL: BASE, secret: "test-secret-".repeat(4), db: h.db }),
        baseURL: BASE,
        publish: { db: h.db, appOrigin: BASE, now: () => new Date(h.nowMs) },
        random: rng(1),
      }),
  };

  beforeAll(async () => {
    // 同時の書き込みを本当に並行させるため、接続は複数にする
    const handle = createDb(url, { max: 4 });
    h.db = handle.db;
    close = handle.close;
    await resetDb(h.db);
    await migrateDb(h.db);
  }, 60_000);

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    await h.db.execute(
      sql`truncate table sessions, runs, reports, likes, post_stats, tree_locks, moderation_actions, actors, posts, games, users, auth_user cascade`,
    );
    h.nowMs = START;
    h.replays = new Map();
    h.replayFails = false;
    const auth = createAuth({
      baseURL: BASE,
      secret: "test-secret-".repeat(4),
      db: h.db,
      extraPlugins: [testUtils()],
    });
    h.app = createApp({
      auth,
      baseURL: BASE,
      publish: { db: h.db, appOrigin: BASE, now: () => new Date(h.nowMs) },
      random: rng(1),
      replays: {
        async putReplay(key, gz) {
          if (h.replayFails) throw new Error("R2 に書けない");
          h.replays.set(key, gz);
        },
      },
    });
    const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    h.login = async (email) => {
      const user = test.createUser({ email, name: "Taku Sakuma" });
      await test.saveUser(user);
      const { cookies } = await test.login({ userId: user.id });
      await h.db.insert(s.users).values({ id: user.id, handle: email.split("@")[0] ?? "h" });
      return { id: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    };
    await h.db.insert(s.users).values({ id: "author", handle: "author" });
    await h.db.insert(s.games).values({
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

  return h;
}
