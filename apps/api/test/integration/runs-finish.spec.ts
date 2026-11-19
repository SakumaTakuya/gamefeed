/**
 * `POST /api/runs/{id}/finish`（ランを閉じ、凍結した成績表を返す）の integration テスト。
 * run#A.3 / A.7 / A.11、sc#A.9、dm#A.5 I13。R-sc.A9-1、R-run.A7-2（到達本数 = 記録の長さ）、R-run.A3-4（finish で閉じる）。
 * Postgres と Better Auth は本物。時計はテストが進める。記録は `PUT /runs/{id}/turns/{t}` で本当に作る。
 * 誰が呼べるか、応答の形など文書に無い点は #161 の D の案。
 */
import { deviation, missBelow } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import {
  DIST,
  device,
  expectError,
  guest,
  START,
  TARGET,
  useRunHarness,
} from "../helpers/run-harness.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので finish の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const MIN = 60_000;
const THRESHOLD = missBelow(DIST);
const dev = (score: number) => deviation(score, DIST);

dbSuite("POST /api/runs/{id}/finish（run#A.3、sc#A.9）", () => {
  const h = useRunHarness(url as string);

  describe("成績表は記録から決まる", () => {
    it("R-sc.A9-1 途中でやめたラン: 記録の手番ごとの値・到達本数・平均偏差値を返し、runs に凍結する（ended: abandoned）", async () => {
      await h.seedCalibrated(4);
      const run = await h.createRun();
      const deck = run.deck.map((d) => d.post_id);
      await h.settle(run.run_id, 0, guest({ score: 55 }));
      await h.settle(run.run_id, 1, guest({ score: THRESHOLD - 1 }));
      await h.settle(run.run_id, 2, { via: "timeout" });
      await h.settle(run.run_id, 3, { via: "noload" });
      h.nowMs += 5000;
      const res = await h.postFinish(run.run_id);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const report = await res.json();
      expect(res.status, JSON.stringify(report)).toBe(200);
      // 平均は偏差値のある手番（成立とミス）だけ。0.1 単位で丸める
      const avg = Math.round((dev(55) * 10 + dev(THRESHOLD - 1) * 10) / 2) / 10;
      expect(report).toEqual({
        run_id: run.run_id,
        mode: "endless",
        ended: "abandoned",
        reached: 4,
        avg_deviation: avg,
        symbols: null,
        turns: [
          {
            turn: 0,
            post_id: deck[0],
            kind: "ok",
            deviation: dev(55),
            ratio: null,
            is_new: false,
            speed: 1,
          },
          {
            turn: 1,
            post_id: deck[1],
            kind: "miss",
            deviation: dev(THRESHOLD - 1),
            ratio: null,
            is_new: false,
            speed: 1,
          },
          // 満了も読み込みの skip も「—」（kind: skip）。到達本数には入る
          {
            turn: 2,
            post_id: deck[2],
            kind: "skip",
            deviation: null,
            ratio: null,
            is_new: false,
            speed: 1,
          },
          {
            turn: 3,
            post_id: deck[3],
            kind: "skip",
            deviation: null,
            ratio: null,
            is_new: false,
            speed: 1,
          },
        ],
      });
      const row = await h.runRow(run.run_id);
      expect(row).toMatchObject({
        settled: 4,
        reached: 4,
        avgDeviation: avg.toFixed(1),
        symbols: null,
        ended: "abandoned",
      });
      expect(row?.endedAt?.getTime()).toBe(h.nowMs);
    });

    it("R-sc.A9-1 校正中・新作扱いの手番は比を返し、平均偏差値に入らない", async () => {
      await h.seedPost({ calibration: "uncalibrated" });
      const run = await h.createRun();
      expect(run.deck[0]).toMatchObject({ is_new: true, miss_below: null });
      await h.settle(run.run_id, 0, guest({ score: 6 }));
      const report = await h.finish(run.run_id);
      expect(report).toMatchObject({ reached: 1, avg_deviation: null, ended: "abandoned" });
      expect(report.turns).toEqual([
        {
          turn: 0,
          post_id: "post-1",
          kind: "ok",
          deviation: null,
          ratio: 6 / TARGET,
          is_new: true,
          speed: 1,
        },
      ]);
    });

    it("結果が 1 つも無いランは到達 0 本で abandoned", async () => {
      await h.seedPost();
      const run = await h.createRun();
      expect(await h.finish(run.run_id)).toEqual({
        run_id: run.run_id,
        mode: "endless",
        ended: "abandoned",
        reached: 0,
        avg_deviation: null,
        symbols: null,
        turns: [],
      });
    });

    it("R-run.A7-2 3 回目のミスで閉じたラン: 到達本数は記録の長さで、閉じたときに凍結した値を返す（ended: lives）", async () => {
      await h.seedPost();
      const run = await h.createRun();
      for (let t = 0; t < 3; t++) await h.settle(run.run_id, t, guest({ score: THRESHOLD - 1 }));
      const closed = await h.runRow(run.run_id);
      expect(closed).toMatchObject({ ended: "lives", reached: 3 });
      // その後に送った結果は足されない（F9）ので、成績表にも入らない
      h.nowMs += 10_000;
      expect((await h.put(run.run_id, 3, guest({ score: 999 }))).status).toBe(409);
      const report = await h.finish(run.run_id);
      expect(report).toMatchObject({ ended: "lives", reached: 3 });
      expect(report.turns.map((t) => [t.kind, t.speed])).toEqual([
        ["miss", 1],
        ["miss", 1.125],
        ["miss", 1.25],
      ]);
      // finish は閉じた時刻を動かさない
      expect(await h.runRow(run.run_id)).toEqual(closed);
    });

    it("R-sc.A9-1 読み込みの skip 3 本で閉じたランは ended: error、次の手番が無くなったランは ended: limit", async () => {
      await h.seedCalibrated(4);
      const lost = await h.createRun({ device: device(1) });
      for (let t = 0; t < 3; t++) {
        await h.settle(lost.run_id, t, { via: "noload" }, { device: device(1) });
      }
      expect(await h.finish(lost.run_id, { device: device(1) })).toMatchObject({
        ended: "error",
        reached: 3,
        avg_deviation: null,
      });

      const stuck = await h.createRun({ device: device(2) });
      for (let t = 0; t < 4; t++) {
        await h.settle(
          stuck.run_id,
          t,
          { via: t === 3 ? "noload" : "timeout" },
          { device: device(2) },
        );
      }
      // 4 本とも skip で、山札の出せる位置が無い（読み込みの skip は 1 本だけ）
      expect(await h.finish(stuck.run_id, { device: device(2) })).toMatchObject({
        ended: "limit",
        reached: 4,
      });
    });

    it("R-sc.A9-1 期限で閉じたラン: finish は期限までの記録から成績表を返す。閉じた時刻は作成 + 60 分", async () => {
      await h.seedPost();
      const run = await h.createRun();
      await h.settle(run.run_id, 0, guest({ score: 55 }));
      h.nowMs = START + 90 * MIN;
      const report = await h.finish(run.run_id);
      expect(report).toMatchObject({ ended: "abandoned", reached: 1, avg_deviation: dev(55) });
      expect(report.turns).toHaveLength(1);
      expect((await h.runRow(run.run_id))?.endedAt?.getTime()).toBe(START + 60 * MIN);
    });
  });

  describe("凍結した値は変わらない（I13）", () => {
    it("R-sc.A9-1 finish の後に同じゲームへ 100 件足しても、runs の値も 2 回目の finish の応答も変わらない（S6）", async () => {
      await h.seedPost();
      const run = await h.createRun();
      await h.settle(run.run_id, 0, guest({ score: 55 }));
      await h.settle(run.run_id, 1, guest({ score: 105 }));
      const first = await h.finish(run.run_id);
      const frozen = await h.runRow(run.run_id);

      // ほかの 100 人が高い点を出して分布が動く
      await h.playAll(
        Array.from({ length: 100 }, (_, i) => guest({ score: 1000 + i })),
        1000,
      );
      expect((await h.stats())?.scores.length).toBeGreaterThan(DIST.length + 100);
      h.nowMs += 10_000;
      expect(await h.finish(run.run_id)).toEqual(first);
      expect(await h.runRow(run.run_id)).toEqual(frozen);
    });

    it("何度呼んでも同じ成績表を返し、ended_at も変わらない。同時に呼んでも同じ", async () => {
      await h.seedPost();
      const run = await h.createRun();
      await h.settle(run.run_id, 0, guest());
      const responses = await Promise.all([1, 2, 3, 4].map(() => h.postFinish(run.run_id)));
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      const frozen = await h.runRow(run.run_id);
      h.nowMs += 30 * MIN;
      expect(await h.finish(run.run_id)).toEqual(bodies[0]);
      // 期限を過ぎてから呼んでも、閉じたランは変わらない
      h.nowMs += 60 * MIN;
      expect(await h.finish(run.run_id)).toEqual(bodies[0]);
      expect(await h.runRow(run.run_id)).toEqual(frozen);
    });

    it("結果の追記と finish が同時に来ても、記録と成績表は食い違わない（成績表に載った手番だけが記録にある）", async () => {
      await h.seedPost();
      const run = await h.createRun();
      await h.settle(run.run_id, 0, guest());
      h.nowMs += 10_000;
      const [put, fin] = await Promise.all([
        h.put(run.run_id, 1, guest({ score: 77 })),
        h.postFinish(run.run_id),
      ]);
      const report = (await fin.json()) as { reached: number; turns: unknown[] };
      // どちらが先でもよい。追記が先なら 2 本、finish が先なら追記は 409
      expect([200, 409]).toContain(put.status);
      expect(report.reached).toBe(put.status === 200 ? 2 : 1);
      expect(report.turns).toHaveLength(report.reached);
      expect(await h.turnRows(run.run_id)).toHaveLength(report.reached);
      expect(await h.runRow(run.run_id)).toMatchObject({
        settled: report.reached,
        reached: report.reached,
      });
    });

    it("ランが無い・ほかの主体のランは 404 run_not_found、X-Device-Id が無いと 400。どちらもランを閉じない", async () => {
      await h.seedPost();
      const run = await h.createRun();
      await expectError(await h.postFinish(run.run_id, { device: device(9) }), 404, {
        error: "run_not_found",
      });
      await expectError(await h.postFinish("01JCXXXXXXXXXXXXXXXXXXXXXX"), 404, {
        error: "run_not_found",
      });
      await expectError(await h.postFinish(run.run_id, { device: null }), 400, {
        error: "invalid_device",
      });
      expect(await h.runRow(run.run_id)).toMatchObject({ ended: null, endedAt: null });
    });
  });
});
