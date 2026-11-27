/**
 * `PUT /api/runs/{id}/turns/{t}`（手番の結果を記録に足す）の integration テスト。
 * run#A.3 / A.6 / A.7 / A.15（F9）、sc#A.2 / A.4 / A.5 / A.7、mo#A.2 / A.3、dm#A.5 I7・I13・I15、dm#A.6。
 * R-run.A3-1、R-run.A3-4、R-run.A7-1（サーバ側）、R-run.A7-2、R-run.A15-2（F9）、R-sc.A2-1、R-sc.A4-1、
 * R-sc.A7-1、R-dm.A5-15（受理の部分）、R-mo.A2-3、R-mo.A3-2。
 * Postgres と Better Auth は本物。時計はテストが進める。誰が送れるかなど文書に無い点は #161 の C の案。
 */
import { gunzipSync } from "node:zlib";
import { deviation, ENDLESS_TURN_LIMIT, missBelow, turnSeed } from "@gamefeed/domain";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.ts";
import {
  DEVICE_A,
  DIST,
  DURATION_FRAMES,
  device,
  expectError,
  guest,
  headers,
  type Plan,
  type Req,
  START,
  useRunHarness,
} from "../helpers/run-harness.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので turns の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const MIN = 60_000;
const THRESHOLD = missBelow(DIST);
/** ミスになる遊んだ結果（校正済みで分布が DIST のゲーム） */
const missed = () => guest({ score: THRESHOLD - 1 });
const spread = (n: number) => Array.from({ length: n }, (_, i) => guest({ score: i + 1 }));
const SKIP = { deviation: null, miss: false, calibration: "calibrated", ratio: null };

dbSuite("PUT /api/runs/{id}/turns/{t}（run#A.3、sc#A.2）", () => {
  const h = useRunHarness(url as string);
  const settledOf = async (runId: string) => (await h.runRow(runId))?.settled;

  // ---- 記録に足す ------------------------------------------------------------------

  describe("記録に手番の順に足す（run#A.3）", () => {
    it("R-run.A3-1 next と sessions の result は無い。ランを作っただけでは sessions に行が入らない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      const next = await h.app.request(`/api/runs/${run.run_id}/next`, {
        method: "POST",
        headers: headers(),
      });
      expect(next.status).toBe(404);
      const result = await h.app.request("/api/sessions/01JCXXXXXXXXXXXXXXXXXXXXXX/result", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(guest()),
      });
      expect(result.status).toBe(404);
      expect(await h.turnRows(run.run_id)).toEqual([]);
      expect(await settledOf(run.run_id)).toBe(0);
    });

    it("R-run.A3-4 R-sc.A2-1 t = settled の結果を足す: 200 で {settled, deviation, miss, calibration, ratio}、sessions に submitted の 1 行", async () => {
      await h.seedPost();
      const run = await h.createRun();
      expect(run.deck).toEqual([
        { post_id: "post-1", is_new: false, miss_below: THRESHOLD, time_limit: DURATION_FRAMES },
      ]);
      h.nowMs += 10_000;
      const res = await h.put(run.run_id, 0, guest({ score: 55 }));
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      // 偏差値は受理時点の分布（自分の結果を含めない 20 件）に対して出す（sc#A.5）
      expect(body).toEqual({
        settled: 1,
        deviation: deviation(55, DIST),
        miss: false,
        calibration: "calibrated",
        ratio: null,
      });

      const rows = await h.turnRows(run.run_id);
      expect(rows).toHaveLength(1);
      // 手番の値は計画と手番番号から（run#A.3）。ランの手番は submitted で入る（dm#A.3）
      expect(rows[0]).toMatchObject({
        postId: "post-1",
        gameHash: "h-1",
        turn: 0,
        mode: "play",
        seed: turnSeed(run.seed, 0),
        speed: "1.000",
        timeLimit: DURATION_FRAMES,
        missBelow: THRESHOLD,
        isNew: false,
        author: false,
        deviceKind: "other",
        state: "submitted",
        via: "guest",
        score: 55,
        frames: DURATION_FRAMES,
        verdict: "provisional",
        deviation: deviation(55, DIST).toFixed(1),
      });
      expect(rows[0]?.issuedAt.getTime()).toBe(START + 10_000);
      expect(rows[0]?.submittedAt?.getTime()).toBe(START + 10_000);
      expect(await h.runRow(run.run_id)).toMatchObject({ settled: 1, ended: null, endedAt: null });
      // 分布には同じトランザクションで入る（昇順のまま）
      expect(await h.stats()).toEqual({
        scores: [...DIST, 55].sort((a, b) => a - b),
        failures: 0,
      });
    });

    it("R-run.A3-4 手番の位置・速度・seed はサーバが計画と記録から求める（2 周目は 1.125 倍）。端末の種類は User-Agent から", async () => {
      await h.seedCalibrated(2);
      const run = await h.createRun();
      for (let t = 0; t < 3; t++) {
        h.nowMs += 10_000;
        const res = await h.app.request(`/api/runs/${run.run_id}/turns/${t}`, {
          method: "PUT",
          headers: { ...headers(), "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0)" },
          body: JSON.stringify(guest()),
        });
        expect(res.status).toBe(200);
      }
      const rows = await h.turnRows(run.run_id);
      expect(rows.map((r) => [r.postId, r.speed, r.seed, r.deviceKind])).toEqual([
        [run.deck[0]?.post_id, "1.000", turnSeed(run.seed, 0), "ios"],
        [run.deck[1]?.post_id, "1.000", turnSeed(run.seed, 1), "ios"],
        [run.deck[0]?.post_id, "1.125", turnSeed(run.seed, 2), "ios"],
      ]);
    });

    it("R-run.A3-4 t < settled は 200 で同じ内容を返す。本文は見ず、何も変えない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      const first = await h.settle(run.run_id, 0, guest({ score: 55 }));
      const before = await h.turnRows(run.run_id);
      const stats = await h.stats();
      for (const body of [guest({ score: 55 }), guest({ score: 999 }), { via: "noload" }, "{"]) {
        h.nowMs += 1000;
        const res = await h.put(run.run_id, 0, body);
        expect(await res.json()).toEqual(first);
        expect(res.status).toBe(200);
      }
      expect(await h.turnRows(run.run_id)).toEqual(before);
      expect(await h.stats()).toEqual(stats);
      expect(h.replays.size).toBe(1);
      // 記録が進んだ後も手番ごとの値は同じ。settled は記録の長さ（次に足す手番の番号）
      await h.settle(run.run_id, 1, guest({ score: 77 }));
      const again = await h.put(run.run_id, 0, guest());
      expect(await again.json()).toEqual({ ...first, settled: 2 });
    });

    it("R-run.A3-4 t > settled は 409 out_of_order で、何も足さない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      h.nowMs += 10_000;
      await expectError(await h.put(run.run_id, 1, guest()), 409, {
        error: "out_of_order",
        settled: 0,
      });
      await h.settle(run.run_id, 0, guest());
      await expectError(await h.put(run.run_id, 5, guest()), 409, {
        error: "out_of_order",
        settled: 1,
      });
      expect(await h.turnRows(run.run_id)).toHaveLength(1);
      expect(await h.stats()).toMatchObject({ scores: { length: DIST.length + 1 } });
    });

    it("R-run.A3-4 同じ手番を 4 接続で同時に送っても記録は 1 行で、応答はすべて同じ（I7）", async () => {
      await h.seedPost();
      const run = await h.createRun();
      h.nowMs += 10_000;
      const responses = await Promise.all(
        [50, 60, 70, 80].map((score) => h.put(run.run_id, 0, guest({ score }))),
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      const rows = await h.turnRows(run.run_id);
      expect(rows).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        settled: 1,
        deviation: deviation(rows[0]?.score ?? -1, DIST),
      });
      expect((await h.stats())?.scores).toHaveLength(DIST.length + 1);
      expect(h.replays.size).toBe(1);
    });

    it("主体が違う・ランが無いと 404 run_not_found、X-Device-Id が無いと 400、t が手番番号でないと 400。どれも記録を変えない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      h.nowMs += 10_000;
      await expectError(await h.put(run.run_id, 0, guest(), { device: device(9) }), 404, {
        error: "run_not_found",
      });
      await expectError(await h.put("01JCXXXXXXXXXXXXXXXXXXXXXX", 0, guest()), 404, {
        error: "run_not_found",
      });
      await expectError(await h.put(run.run_id, 0, guest(), { device: null }), 400, {
        error: "invalid_device",
      });
      for (const t of ["x", "-1", "1.5", "01", "1e1"]) {
        await expectError(await h.put(run.run_id, t, guest()), 400, { error: "invalid_request" });
      }
      expect(await h.turnRows(run.run_id)).toEqual([]);
      expect((await h.put(run.run_id, 0, guest())).status).toBe(200);
    });
  });

  // ---- 閉じる ----------------------------------------------------------------------

  describe("ランが閉じる条件と、閉じた後（run#A.3、F9）", () => {
    it("R-run.A3-4 R-run.A7-2 3 回目のミスが入ったら閉じる。その後に送った結果は 409 run_closed で足されない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      expect((await h.settle(run.run_id, 0, missed())).miss).toBe(true);
      expect((await h.settle(run.run_id, 1, missed())).miss).toBe(true);
      expect(await h.runRow(run.run_id)).toMatchObject({ settled: 2, endedAt: null });
      const third = await h.settle(run.run_id, 2, missed());
      expect(third).toMatchObject({ settled: 3, miss: true });
      const closed = await h.runRow(run.run_id);
      expect(closed).toMatchObject({ settled: 3, reached: 3, ended: "lives" });
      expect(closed?.endedAt?.getTime()).toBe(h.nowMs);

      // ミスを無視して遊び続けるクライアントが何を送っても、記録は伸びない（F9）
      for (const body of [guest({ score: 999 }), { via: "noload" }]) {
        h.nowMs += 10_000;
        await expectError(await h.put(run.run_id, 3, body), 409, {
          error: "run_closed",
          settled: 3,
        });
        await expectError(await h.put(run.run_id, 7, body), 409, {
          error: "run_closed",
          settled: 3,
        });
      }
      expect(await h.turnRows(run.run_id)).toHaveLength(3);
      expect(await h.runRow(run.run_id)).toEqual(closed);
      // 記録にある手番への送り直しは、閉じた後も同じ内容
      expect(await (await h.put(run.run_id, 2, guest())).json()).toEqual(third);
    });

    it("R-run.A7-2 R-run.A15-2 ミスの結果を送らずに次の手番を送っても足されない（409 out_of_order。F9）", async () => {
      await h.seedPost();
      const run = await h.createRun();
      await h.settle(run.run_id, 0, missed());
      await h.settle(run.run_id, 1, missed());
      h.nowMs += 20_000;
      // 3 回目のミス（手番 2）を送らず、手番 3 を送る
      await expectError(await h.put(run.run_id, 3, guest({ score: 999 })), 409, {
        error: "out_of_order",
        settled: 2,
      });
      expect(await h.turnRows(run.run_id)).toHaveLength(2);
      expect(await h.runRow(run.run_id)).toMatchObject({ settled: 2, endedAt: null });
    });

    it("R-run.A3-4 3 本目の読み込みの skip が入ったら閉じる（ended: error）", async () => {
      await h.seedCalibrated(5);
      const run = await h.createRun();
      await h.settle(run.run_id, 0, { via: "noload" });
      await h.settle(run.run_id, 1, guest());
      await h.settle(run.run_id, 2, { via: "noload" });
      expect(await h.runRow(run.run_id)).toMatchObject({ settled: 3, endedAt: null });
      expect(await h.settle(run.run_id, 3, { via: "noload" })).toEqual({ settled: 4, ...SKIP });
      expect(await h.runRow(run.run_id)).toMatchObject({ settled: 4, reached: 4, ended: "error" });
      h.nowMs += 10_000;
      await expectError(await h.put(run.run_id, 4, guest()), 409, {
        error: "run_closed",
        settled: 4,
      });
    });

    it("R-run.A3-4 記録の長さが上限（50 手番）に達したら閉じる（ended: limit）", async () => {
      // 校正中のゲームはミスにならないので、上限まで続く
      await h.seedPost({ calibration: "uncalibrated" });
      const run = await h.createRun();
      for (let t = 0; t < ENDLESS_TURN_LIMIT; t++) await h.settle(run.run_id, t, guest());
      expect(await h.runRow(run.run_id)).toMatchObject({
        settled: ENDLESS_TURN_LIMIT,
        reached: ENDLESS_TURN_LIMIT,
        ended: "limit",
      });
      h.nowMs += 10_000;
      await expectError(await h.put(run.run_id, ENDLESS_TURN_LIMIT, guest()), 409, {
        error: "run_closed",
        settled: ENDLESS_TURN_LIMIT,
      });
      expect(await h.turnRows(run.run_id)).toHaveLength(ENDLESS_TURN_LIMIT);
    });

    it("R-run.A3-4 山札の出せる位置が無くなったら閉じる（ended: limit）", async () => {
      await h.seedPost();
      const run = await h.createRun();
      // 山札は 1 本。満了になった位置は以後の周回に出ない（run#A.6）ので、次の手番が無い
      await h.settle(run.run_id, 0, { via: "timeout" });
      expect(await h.runRow(run.run_id)).toMatchObject({ settled: 1, reached: 1, ended: "limit" });
      h.nowMs += 10_000;
      await expectError(await h.put(run.run_id, 1, guest()), 409, {
        error: "run_closed",
        settled: 1,
      });
    });

    it("R-run.A3-4 finish の後は足されない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      await h.settle(run.run_id, 0, guest());
      await h.finish(run.run_id);
      h.nowMs += 10_000;
      await expectError(await h.put(run.run_id, 1, guest()), 409, {
        error: "run_closed",
        settled: 1,
      });
      expect(await h.turnRows(run.run_id)).toHaveLength(1);
    });

    it("R-run.A3-4 作成から 60 分ちょうどまでは足され、過ぎたランは閉じている。finish が来なくても閉じる", async () => {
      await h.seedPost();
      const onTime = await h.createRun({ device: device(1) });
      const late = await h.createRun({ device: device(2) });
      const half = await h.createRun({ device: device(3) });
      await h.settle(half.run_id, 0, guest(), { device: device(3) });

      h.nowMs = START + 60 * MIN;
      expect((await h.put(onTime.run_id, 0, guest(), { device: device(1) })).status).toBe(200);

      h.nowMs = START + 60 * MIN + 1;
      await expectError(await h.put(late.run_id, 0, guest(), { device: device(2) }), 409, {
        error: "run_closed",
        settled: 0,
      });
      // 期限を見たときに閉じる。閉じた時刻は作成 + 60 分（dm#A.3）
      const closed = await h.runRow(late.run_id);
      expect(closed).toMatchObject({ settled: 0, reached: 0, ended: "abandoned" });
      expect(closed?.endedAt?.getTime()).toBe(START + 60 * MIN);
      expect(await h.turnRows(late.run_id)).toEqual([]);

      // 期限の前に足した手番は残り、その先は足されない
      await expectError(await h.put(half.run_id, 1, guest(), { device: device(3) }), 409, {
        error: "run_closed",
        settled: 1,
      });
      expect(await h.runRow(half.run_id)).toMatchObject({ reached: 1, ended: "abandoned" });
      expect((await h.put(half.run_id, 0, guest(), { device: device(3) })).status).toBe(200);
    });
  });

  // ---- 結果の形と述語 ----------------------------------------------------------------

  describe("結果の形と述語（sc#A.2）", () => {
    it("R-sc.A2-1 満了・error・読み込みの skip は値を持たずに記録に足し、その位置は以後の周回に出ない（run#A.6）", async () => {
      await h.seedCalibrated(4);
      const run = await h.createRun();
      const deck = run.deck.map((d) => d.post_id);
      for (const [t, via] of ["timeout", "error", "noload"].entries()) {
        expect(await h.settle(run.run_id, t, { via })).toEqual({ settled: t + 1, ...SKIP });
      }
      // 残った位置は 1 つ。次の手番も、その次（2 周目）もそこに当たる
      await h.settle(run.run_id, 3, guest());
      await h.settle(run.run_id, 4, guest());
      const rows = await h.turnRows(run.run_id);
      expect(rows.map((r) => [r.postId, r.via, r.speed])).toEqual([
        [deck[0], "timeout", "1.000"],
        [deck[1], "error", "1.000"],
        [deck[2], "noload", "1.000"],
        [deck[3], "guest", "1.000"],
        [deck[3], "guest", "1.125"],
      ]);
      for (const row of rows.slice(0, 3)) {
        expect(row).toMatchObject({
          state: "submitted",
          score: null,
          frames: null,
          deviation: null,
          logKey: null,
          verdict: "provisional",
        });
      }
    });

    it("R-sc.A2-1 4 つの形のどれでもない本文は 400 invalid_request で、記録は進まない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      h.nowMs += 10_000;
      const { inputs: _inputs, ...noInputs } = guest();
      for (const body of [
        "{",
        "null",
        "[1]",
        '"x"',
        {},
        { via: "host" },
        { skipped: true },
        { via: "timeout", score: 0 },
        { via: "noload", frames: 0 },
        noInputs,
        guest({ author: true }),
      ]) {
        await expectError(await h.put(run.run_id, 0, body), 400, { error: "invalid_request" });
      }
      expect(await h.turnRows(run.run_id)).toEqual([]);
      expect(await settledOf(run.run_id)).toBe(0);
      expect((await h.put(run.run_id, 0, guest())).status).toBe(200);
    });

    const rejections: {
      name: string;
      reason: string;
      body: Record<string, unknown>;
      sec?: number;
    }[] = [
      { name: "score が負", reason: "score", body: { score: -1 } },
      { name: "score が 2³¹ 以上", reason: "score", body: { score: 2 ** 31 } },
      { name: "score が整数でない", reason: "score", body: { score: 1.5 } },
      { name: "frames が time_limit 超過", reason: "frames", body: { frames: 301 } },
      { name: "frames が負", reason: "frames", body: { frames: -1, inputs: [] } },
      { name: "入力ログが配列でない", reason: "inputs", body: { inputs: "x" } },
      {
        name: "入力ログの frame が減る",
        reason: "inputs",
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
        body: { frames: 280, inputs: [[281, "tap", 0.5, 0.5]] },
      },
      // 300 フレーム等速は 5 秒。作成の 1 秒後では 1.05 + 0.1 + 3 = 4.15 秒ぶんしか遊べない
      { name: "実時間より多いフレーム", reason: "realtime", body: {}, sec: 1 },
      // 複数に外れたら、表で上にある条件
      { name: "score と frames の両方", reason: "score", body: { score: -1, frames: 301 } },
    ];
    for (const c of rejections) {
      it(`R-sc.A2-1 R-run.A3-4 ${c.name} → 422 invalid_result（${c.reason}）。何も保存せず、正しく送り直すと足される`, async () => {
        await h.seedPost();
        const run = await h.createRun();
        h.nowMs += (c.sec ?? 10) * 1000;
        await expectError(await h.put(run.run_id, 0, guest(c.body)), 422, {
          error: "invalid_result",
          reason: c.reason,
        });
        expect(await h.turnRows(run.run_id)).toEqual([]);
        expect(await h.runRow(run.run_id)).toMatchObject({ settled: 0, endedAt: null });
        expect(await h.stats()).toEqual({ scores: DIST, failures: 0 });
        expect(h.replays.size).toBe(0);
        // 後ろの手番は、この手番が入るまで入らない
        await expectError(await h.put(run.run_id, 1, guest()), 409, {
          error: "out_of_order",
          settled: 0,
        });
        expect(await h.settle(run.run_id, 0, guest())).toMatchObject({ settled: 1 });
      });
    }

    it("R-sc.A2-1 境界: frames = 0、frames = time_limit で入力の frame = frames は足される", async () => {
      await h.seedPost();
      const run = await h.createRun();
      // 開始直後に終わった結果も遊んだ結果（#162）。短いので分布には入らない
      const zero = await h.settle(run.run_id, 0, guest({ score: 0, frames: 0, inputs: [] }), {}, 0);
      expect(zero).toMatchObject({ settled: 1, deviation: deviation(0, DIST) });
      expect(await h.stats()).toEqual({ scores: DIST, failures: 0 });
      await h.settle(run.run_id, 1, guest({ inputs: [[DURATION_FRAMES, "tap", 0, 0]] }));
      expect((await h.turnRows(run.run_id)).map((r) => r.frames)).toEqual([0, DURATION_FRAMES]);
    });

    it("R-sc.A2-1 実時間はランの合計で見る: 手番ごとには通る結果でも、合計が経過時間を超えたら 422", async () => {
      await h.seedCalibrated(2);
      const run = await h.createRun({ device: device(1) });
      const other = await h.createRun({ device: device(2) });
      const four = guest({ frames: 240, inputs: [] });
      // 作成の 1 秒後。4 秒ぶんは 1 件なら通る（1.05 + 0.1 + 3 = 4.15）
      await h.settle(run.run_id, 0, four, { device: device(1) }, 1);
      // 同じ時刻にもう 4 秒ぶん。合計 8 秒は 1.05 + 0.2 + 3 = 4.25 を超える
      await expectError(await h.put(run.run_id, 1, four, { device: device(1) }), 422, {
        error: "invalid_result",
        reason: "realtime",
      });
      // 記録に遊んだ結果が無いランなら、同じ時刻・同じ手番番号の同じ結果が通る
      await h.settle(other.run_id, 0, { via: "timeout" }, { device: device(2) }, 0);
      await h.settle(other.run_id, 1, four, { device: device(2) }, 0);
      // 時間が経てば、拒否された手番も足される
      expect(await h.settle(run.run_id, 1, four, { device: device(1) })).toMatchObject({
        settled: 2,
      });
    });
  });

  // ---- 偏差値・比・ミス ----------------------------------------------------------------

  describe("応答の値（sc#A.2、A.5、run#A.7）", () => {
    it("R-sc.A2-1 校正中のゲーム: deviation は null で ratio = min(1, score / target)", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      const [half, over] = await h.playAll([guest({ score: 6 }), guest({ score: 30 })]);
      expect(half).toEqual({
        settled: 1,
        deviation: null,
        miss: false,
        calibration: "uncalibrated",
        ratio: 0.5,
      });
      expect(over?.ratio).toBe(1);
      expect(await h.stats()).toEqual({ scores: [6, 30], failures: 0 });
    });

    it("R-run.A7-1 サーバは計画に凍結した miss_below で判定する。作成の後に分布が動いても変わらない", async () => {
      await h.seedPost();
      const below = await h.createRun({ device: device(1) });
      const at = await h.createRun({ device: device(2) });
      expect(below.deck[0]?.miss_below).toBe(THRESHOLD);
      // 作成の後に分布が大きく上がる。いまの分布なら THRESHOLD 点は偏差値 40 未満
      const high = DIST.map((v) => v + 1000);
      await h.setDist(high);
      const r1 = await h.settle(below.run_id, 0, guest({ score: THRESHOLD - 1 }), {
        device: device(1),
      });
      expect(r1.miss).toBe(true);
      await h.setDist(high);
      const r2 = await h.settle(at.run_id, 0, guest({ score: THRESHOLD }), { device: device(2) });
      expect(r2.miss).toBe(false);
      expect(r2.deviation).toBe(deviation(THRESHOLD, high));
      expect(r2.deviation).toBeLessThan(40);
      expect((await h.turnRows(at.run_id))[0]?.missBelow).toBe(THRESHOLD);
    });
  });

  // ---- 分布と失敗の数 ----------------------------------------------------------------

  describe("分布と失敗の数（sc#A.4、I15）", () => {
    it("R-sc.A4-1 満了と error は失敗の数に入り、分布には入らない。読み込みの skip はどちらにも入らない", async () => {
      await h.seedCalibrated(3);
      const run = await h.createRun();
      const deck = run.deck.map((d) => d.post_id);
      await h.settle(run.run_id, 0, { via: "timeout" });
      await h.settle(run.run_id, 1, { via: "error" });
      await h.settle(run.run_id, 2, { via: "noload" });
      expect(await h.stats(deck[0])).toEqual({ scores: DIST, failures: 1 });
      expect(await h.stats(deck[1])).toEqual({ scores: DIST, failures: 1 });
      expect(await h.stats(deck[2])).toEqual({ scores: DIST, failures: 0 });
    });

    it("R-sc.A4-1 speed > 1.0 の結果は分布にも失敗の数にも入らないが、等速の分布に対する偏差値は出る", async () => {
      await h.seedCalibrated(2);
      const run = await h.createRun();
      const deck = run.deck.map((d) => d.post_id);
      await h.settle(run.run_id, 0, guest({ score: 55 }));
      await h.settle(run.run_id, 1, guest({ score: 55 }));
      const after = [...DIST, 55].sort((a, b) => a - b);
      // 2 周目（1.125 倍）
      const fast = await h.settle(run.run_id, 2, guest({ score: 66 }));
      expect(fast.deviation).toBe(deviation(66, after));
      await h.settle(run.run_id, 3, { via: "timeout" });
      expect((await h.turnRows(run.run_id)).map((r) => r.speed)).toEqual([
        "1.000",
        "1.000",
        "1.125",
        "1.125",
      ]);
      expect(await h.stats(deck[0])).toEqual({ scores: after, failures: 0 });
      expect(await h.stats(deck[1])).toEqual({ scores: after, failures: 0 });
    });

    it("R-sc.A4-1 作者がランで遊んだ結果も、ほかの人と同じに分布と失敗の数に入る（#242）", async () => {
      const me = await h.login("maker@example.test");
      await h.seedPost({ userId: me.id });
      const o = { cookie: me.cookie };
      const r = await h.playOnce(guest({ score: 55 }), o);
      expect(r.deviation).toBe(deviation(55, DIST));
      expect((await h.turnRows(r.runId))[0]).toMatchObject({ author: true, state: "submitted" });
      await h.playOnce({ via: "timeout" }, o);
      expect(await h.stats()).toEqual({
        scores: [...DIST, 55].sort((a, b) => a - b),
        failures: 1,
      });
    });

    it("R-sc.A4-1 短縮されたセッション（frames < 0.9 × time_limit）は入らず、9 割ちょうどは入る", async () => {
      await h.seedPost();
      const short = await h.playOnce(guest({ score: 55, frames: 269 }), { device: device(1) });
      // 本人の偏差値は出す（sc#B.6）
      expect(short.deviation).toBe(deviation(55, DIST));
      expect((await h.stats())?.scores).toEqual(DIST);
      await h.playOnce(guest({ score: 55, frames: 270 }), { device: device(2) });
      expect((await h.stats())?.scores).toHaveLength(DIST.length + 1);
    });

    it("R-sc.A4-1 R-dm.A5-15 1 主体 1 ゲームにつき直近 5 件まで。6 件目で最古が外れ、n は増えない", async () => {
      await h.seedPost();
      for (const score of [1, 2, 3, 4, 5]) await h.playOnce(guest({ score }));
      expect((await h.stats())?.scores).toEqual([1, 2, 3, 4, 5, ...DIST]);
      await h.playOnce(guest({ score: 6 }));
      expect((await h.stats())?.scores).toEqual([2, 3, 4, 5, 6, ...DIST]);
      await h.playOnce(guest({ score: 7 }));
      expect((await h.stats())?.scores).toEqual([3, 4, 5, 6, 7, ...DIST]);
      // 窓は主体ごと。ほかの主体の結果は押し出さない
      await h.playOnce(guest({ score: 8 }), { device: device(1) });
      expect((await h.stats())?.scores).toEqual([3, 4, 5, 6, 7, 8, ...DIST]);
    });

    it("R-sc.A4-1 5 件の窓は分布と失敗の数で共有する: 満了も 1 件と数え、押し出されたら失敗の数から外れる", async () => {
      await h.seedPost();
      for (const score of [1, 2, 3, 4, 5]) await h.playOnce(guest({ score }));
      // 6 件目が満了。最古の 1 点が外れ、失敗が 1 件入る
      await h.playOnce({ via: "timeout" });
      expect(await h.stats()).toEqual({ scores: [2, 3, 4, 5, ...DIST], failures: 1 });
      for (const score of [7, 8, 9, 10]) await h.playOnce(guest({ score }));
      expect(await h.stats()).toEqual({ scores: [7, 8, 9, 10, ...DIST], failures: 1 });
      // 満了が窓の最古になった。次の結果で外れる
      await h.playOnce(guest({ score: 11 }));
      expect(await h.stats()).toEqual({
        scores: [7, 8, 9, 10, 11, ...DIST].sort((x, y) => x - y),
        failures: 0,
      });
    });

    it("R-sc.A4-1 窓は集計に入った結果だけで数える（入らない結果は直近 5 件を押し出さない）", async () => {
      await h.seedPost();
      for (const score of [1, 2, 3, 4, 5]) await h.playOnce(guest({ score }));
      // 短縮された結果と読み込みの skip を挟んでも、分布の 5 件はそのまま
      await h.playOnce(guest({ score: 99, frames: 100, inputs: [] }));
      await h.playOnce({ via: "noload" });
      expect(await h.stats()).toEqual({ scores: [1, 2, 3, 4, 5, ...DIST], failures: 0 });
    });

    it("R-dm.A5-15 別々の主体が同じゲームへ同時に送っても、分布の更新は失われない", async () => {
      await h.seedPost();
      const runs: { run: Plan; o: Req }[] = [];
      for (let i = 0; i < 8; i++) {
        const o = { device: device(i) };
        runs.push({ run: await h.createRun(o), o });
      }
      h.nowMs += 10_000;
      const responses = await Promise.all(
        runs.map(({ run, o }, i) => h.put(run.run_id, 0, guest({ score: 300 + i }), o)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect((await h.stats())?.scores).toEqual([...DIST, 300, 301, 302, 303, 304, 305, 306, 307]);
    });
  });

  // ---- 校正 ------------------------------------------------------------------------

  describe("校正状態の遷移（sc#A.7）", () => {
    const calibrationOf = async () => (await h.postOf())?.calibration;
    const timeouts = (n: number) => Array.from({ length: n }, () => ({ via: "timeout" }));

    it("R-sc.A7-1 4 件目では uncalibrated のまま、5 件目で calibrated になる", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      const first = await h.playAll(spread(4));
      expect(first.map((r) => r.calibration)).toEqual(Array(4).fill("uncalibrated"));
      expect(await calibrationOf()).toBe("uncalibrated");

      const [fifth] = await h.playAll([guest({ score: 5 })], 200);
      // この手番は計画で新作扱いなので、校正済みになった結果でも偏差値ではなく比を出す
      expect(fifth).toEqual({
        settled: 1,
        deviation: null,
        miss: false,
        calibration: "calibrated",
        ratio: expect.any(Number),
      });
      expect(await calibrationOf()).toBe("calibrated");
      expect((await h.stats())?.scores).toEqual(spread(5).map((b) => b.score));
    });

    it("R-sc.A7-1 作者 1 人が自分の端末で 5 回遊ぶだけで calibrated になり、次のランに miss_below が出る（#242）", async () => {
      const me = await h.login("maker@example.test");
      await h.seedPost({ userId: me.id, calibration: "uncalibrated" });
      const o = { cookie: me.cookie };
      const seen: string[] = [];
      for (const score of [30, 10, 50, 20, 40]) {
        seen.push((await h.playOnce(guest({ score }), o)).calibration);
      }
      expect(seen).toEqual([...Array(4).fill("uncalibrated"), "calibrated"]);
      expect(await h.stats()).toEqual({ scores: [10, 20, 30, 40, 50], failures: 0 });
      // ミスは「直近 5 回のどれよりも低い」（sc#A.6）
      const next = await h.createRun(o);
      expect(next.deck[0]).toMatchObject({ is_new: false, miss_below: 10 });
    });

    it("R-sc.A7-1 失敗率 50% 以上の間は 5 件を超えても校正済みにせず、n + f が 20 で invalid", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      await h.playAll(timeouts(10), 200);
      const played = await h.playAll(spread(9));
      // n = 9、f = 10
      expect(played.map((r) => r.calibration)).toEqual(Array(9).fill("uncalibrated"));
      expect(await h.stats()).toMatchObject({ failures: 10 });
      // 20 件目（失敗 10 / 20 = 50%）
      const [last] = await h.playAll([guest({ score: 10 })], 300);
      expect(last?.calibration).toBe("invalid");
      expect(await calibrationOf()).toBe("invalid");
    });

    it("R-sc.A7-1 校正済みになった後でも、n + f が 20 で失敗率 50% 以上なら invalid", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      await h.playAll(spread(10));
      expect(await calibrationOf()).toBe("calibrated");
      const fails = await h.playAll(timeouts(9), 200);
      expect(fails.map((r) => r.calibration)).toEqual(Array(9).fill("calibrated"));
      const [last] = await h.playAll(timeouts(1), 300);
      expect(last).toMatchObject({ deviation: null, miss: false, calibration: "invalid" });
      expect(await calibrationOf()).toBe("invalid");
    });

    it("R-sc.A7-1 失敗率が 50% 未満なら、分布が 5 件になったところで決まる", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      await h.playAll(timeouts(4), 200);
      await h.playAll(spread(4));
      // n = 4、f = 4
      expect(await calibrationOf()).toBe("uncalibrated");
      await h.playAll([guest({ score: 5 })], 300);
      expect(await calibrationOf()).toBe("calibrated");
    });

    it("R-sc.A7-1 集計に入らない結果は校正の件数に数えない", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      await h.playAll(spread(4));
      await h.playAll([guest({ score: 9, frames: 100, inputs: [] }), { via: "noload" }], 300);
      expect(await calibrationOf()).toBe("uncalibrated");
    });

    it("R-sc.A7-1 5 件が全部同じ点・0 ばかりの間は uncalibrated のまま待ち、ばらつけば calibrated", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      const same = await h.playAll(Array.from({ length: 6 }, () => guest({ score: 1 })));
      expect(same.map((r) => r.calibration)).toEqual(Array(6).fill("uncalibrated"));
      const [moved] = await h.playAll([guest({ score: 0 })], 300);
      expect(moved?.calibration).toBe("calibrated");
    });

    it("R-sc.A7-1 20 件目で全件同じ点（分散ゼロ）なら invalid", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      const all = await h.playAll(Array.from({ length: 20 }, () => guest({ score: 7 })));
      expect(all[4]?.calibration).toBe("uncalibrated");
      expect(all[18]?.calibration).toBe("uncalibrated");
      expect(all[19]?.calibration).toBe("invalid");
      expect(await calibrationOf()).toBe("invalid");
    });

    it("R-sc.A7-1 20 件目で 0 の割合が 80% 以上（0 張り付き）なら invalid", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      const scores = [...Array(16).fill(0), 1, 2, 3, 4];
      const all = await h.playAll(scores.map((score) => guest({ score })));
      expect(all[19]?.calibration).toBe("invalid");
      expect(await calibrationOf()).toBe("invalid");
    });

    it("R-sc.A7-1 invalid は終端。その後に点のばらついた結果が来ても戻らない", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      // invalid になるとランを作れないので、先に作っておく（計画は変わらない）
      const late: { run: Plan; o: Req }[] = [];
      for (let i = 0; i < 6; i++) {
        const o = { device: device(500 + i) };
        late.push({ run: await h.createRun(o), o });
      }
      await h.playAll(Array.from({ length: 20 }, () => guest({ score: 7 })));
      expect(await calibrationOf()).toBe("invalid");
      for (const [i, { run, o }] of late.entries()) {
        const r = await h.settle(run.run_id, 0, guest({ score: 100 + i }), o);
        expect(r.calibration).toBe("invalid");
      }
      expect(await calibrationOf()).toBe("invalid");
      expect((await h.stats())?.scores).toHaveLength(26);
    });

    it("R-sc.A7-1 校正済みのゲームも、20 件以上で全件同じ点なら invalid。20 件に満たなければ calibrated のまま", async () => {
      await h.seedPost();
      await h.setDist(Array(8).fill(7));
      const few = await h.playOnce(guest({ score: 7 }), { device: device(1) });
      expect(few.calibration).toBe("calibrated");

      await h.setDist(Array(20).fill(7));
      const many = await h.playOnce(guest({ score: 7 }), { device: device(2) });
      expect(many.calibration).toBe("invalid");
      expect(await calibrationOf()).toBe("invalid");
    });

    it("R-mo.A2-3 limited の投稿は calibrated になる遷移で public に昇格する", async () => {
      await h.seedPost({ calibration: "uncalibrated", status: "limited" });
      await h.playAll(spread(4));
      expect((await h.postOf())?.baseStatus).toBe("limited");
      await h.playAll([guest({ score: 5 })], 200);
      expect(await h.postOf()).toMatchObject({ calibration: "calibrated", baseStatus: "public" });
    });

    it("R-mo.A2-3 制限中、または upheld の通報がある投稿は校正済みになっても昇格しない", async () => {
      for (const block of ["indiv_restricted", "tree_lock", "upheld"] as const) {
        await h.db.execute(
          sql`truncate table sessions, runs, reports, post_stats, tree_locks, moderation_actions, actors, posts cascade`,
        );
        await h.seedPost({ calibration: "uncalibrated", status: "limited" });
        await h.playAll(spread(4));
        // 5 件目のランを作ってから制限する（制限中の投稿は山札に入らない）
        const o = { device: device(200) };
        const run = await h.createRun(o);
        if (block === "indiv_restricted") {
          await h.db.execute(sql`update posts set indiv_restricted = true`);
        } else if (block === "tree_lock") {
          const [action] = await h.db
            .insert(s.moderationActions)
            .values({ kind: "restrict_tree", postId: "post-1", reason: "test" })
            .returning();
          await h.db
            .insert(s.treeLocks)
            .values({ rootPostId: "post-1", actionId: action?.id as number });
        } else {
          const [actor] = await h.db.select().from(s.actors).limit(1);
          await h.db.insert(s.reports).values({
            postId: "post-1",
            actorId: actor?.id as string,
            category: "other",
            weight: 0,
            resolution: "upheld",
          });
        }
        const r = await h.settle(run.run_id, 0, guest({ score: 5 }), o);
        expect(r.calibration, block).toBe("calibrated");
        expect(await h.postOf(), block).toMatchObject({
          calibration: "calibrated",
          baseStatus: "limited",
        });
      }
    });

    it("R-mo.A2-3 invalid になった limited の投稿は昇格しない", async () => {
      await h.seedPost({ calibration: "uncalibrated", status: "limited" });
      await h.playAll(Array.from({ length: 20 }, () => guest({ score: 7 })));
      expect(await h.postOf()).toMatchObject({ calibration: "invalid", baseStatus: "limited" });
    });
  });

  // ---- ラン中に出せなくなった投稿 --------------------------------------------------------

  describe("山札はラン中に変えない（mo#A.3）", () => {
    it("R-mo.A3-2 ランの作成後に出せなくなった投稿の手番も、遊んだ結果・読み込みの skip のどちらも足される。その後に作るランの山札には入らない", async () => {
      await h.seedCalibrated(3);
      const run = await h.createRun();
      const deck = run.deck.map((d) => d.post_id);
      await h.db.execute(sql`update posts set indiv_restricted = true where id = ${deck[0]}`);
      await h.db.execute(sql`update posts set base_status = 'unpublished' where id = ${deck[1]}`);

      // 配信が止まる前に読み込んだ手番の結果は受理する。ゲームの記録としても残る（sc#A.4 は投稿状態を条件にしない）
      const played = await h.settle(run.run_id, 0, guest({ score: 55 }));
      expect(played).toMatchObject({ settled: 1, deviation: deviation(55, DIST) });
      expect((await h.stats(deck[0]))?.scores).toHaveLength(DIST.length + 1);
      // 配信が止まった手番は読み込みの skip になる
      expect(await h.settle(run.run_id, 1, { via: "noload" })).toEqual({ settled: 2, ...SKIP });
      expect((await h.turnRows(run.run_id)).map((r) => r.postId)).toEqual([deck[0], deck[1]]);

      const fresh = await h.createRun({ device: device(1) });
      expect(fresh.deck.map((d) => d.post_id)).toEqual([deck[2]]);
    });
  });

  // ---- 入力ログ ----------------------------------------------------------------------

  describe("入力ログの保存（dm#A.6）", () => {
    const readReplay = (key: string): unknown =>
      JSON.parse(gunzipSync(h.replays.get(key) as Uint8Array).toString("utf8"));

    it("記録に足した遊んだ結果の入力ログを replays/{session_id}.json.gz に手番の seed・speed と一緒に置き、log_key を入れる", async () => {
      await h.seedPost();
      const run = await h.createRun();
      const body = guest();
      await h.settle(run.run_id, 0, body);
      await h.settle(run.run_id, 1, body);
      const rows = await h.turnRows(run.run_id);
      const keys = rows.map((r) => `replays/${r.id}.json.gz`);
      expect([...h.replays.keys()]).toEqual(keys);
      expect(rows.map((r) => r.logKey)).toEqual(keys);
      expect(readReplay(keys[0] as string)).toEqual({
        seed: turnSeed(run.seed, 0),
        speed: 1,
        inputs: body.inputs,
      });
      expect(readReplay(keys[1] as string)).toEqual({
        seed: turnSeed(run.seed, 1),
        speed: 1.125,
        inputs: body.inputs,
      });
    });

    it("拒否した結果・skip・記録にある手番への送り直し・409 では何も置かない", async () => {
      await h.seedCalibrated(4);
      const run = await h.createRun();
      h.nowMs += 10_000;
      await h.put(run.run_id, 0, guest({ frames: 301 }));
      await h.put(run.run_id, 0, "{");
      await h.put(run.run_id, 1, guest());
      for (const [t, via] of ["timeout", "error", "noload"].entries()) {
        await h.settle(run.run_id, t, { via });
      }
      await h.put(run.run_id, 0, guest());
      expect(h.replays.size).toBe(0);
      expect((await h.turnRows(run.run_id)).map((r) => r.logKey)).toEqual([null, null, null]);
    });

    it("R2 に書けなくても記録には足され、log_key は NULL のまま残る", async () => {
      await h.seedPost();
      h.replayFails = true;
      const r = await h.playOnce(guest());
      expect((await h.turnRows(r.runId))[0]).toMatchObject({ state: "submitted", logKey: null });
    });

    it("置き場が未設定（R2_* なし）でも記録には足され、log_key は NULL", async () => {
      await h.seedPost();
      const run = await h.createRun();
      h.nowMs += 10_000;
      const res = await h.bareApp().request(`/api/runs/${run.run_id}/turns/0`, {
        method: "PUT",
        headers: headers({ device: DEVICE_A }),
        body: JSON.stringify(guest()),
      });
      expect(res.status).toBe(200);
      expect((await h.turnRows(run.run_id))[0]).toMatchObject({ state: "submitted", logKey: null });
    });
  });
});
