// ラン API の応答の読み方（run#A.3）。通信そのものは実機で確かめる（manual）。
import { describe, expect, it } from "vitest";
import { readPlan, readReport, readTurnReply } from "../src/run/api.ts";

const ID = "01M782MV00TMYMTHTGG5C6KS3T";

describe("readPlan（POST /runs の 201）", () => {
  const body = {
    run_id: ID,
    seed: 4294967295,
    deck: [
      { post_id: ID, is_new: false, miss_below: 12, time_limit: 300 },
      { post_id: ID, is_new: true, miss_below: null, time_limit: 180 },
    ],
  };

  it("計画を読む", () => {
    expect(readPlan(body)).toEqual({ runId: ID, seed: 4294967295, deck: body.deck });
  });

  it("形が違えば null（山札が空、seed が 32 bit 符号なしでない、time_limit が正の整数でない、など）", () => {
    const first = body.deck[0];
    for (const bad of [
      null,
      "x",
      { ...body, run_id: 1 },
      { ...body, seed: -1 },
      { ...body, seed: 2 ** 32 },
      { ...body, seed: 1.5 },
      { ...body, deck: [] },
      { ...body, deck: "x" },
      { ...body, deck: [{ ...first, post_id: 1 }] },
      { ...body, deck: [{ ...first, is_new: "no" }] },
      { ...body, deck: [{ ...first, miss_below: "12" }] },
      { ...body, deck: [{ ...first, time_limit: 0 }] },
      { ...body, deck: [{ ...first, time_limit: 1.5 }] },
      { ...body, deck: [null] },
    ]) {
      expect(readPlan(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("readTurnReply（PUT /runs/{id}/turns/{t}。run#A.3 の表、#161 の 28）", () => {
  it("200 は記録に入った。表示用の値を持つ", () => {
    expect(
      readTurnReply(200, {
        settled: 3,
        deviation: 52.3,
        miss: false,
        calibration: "calibrated",
        ratio: null,
      }),
    ).toEqual({ kind: "settled", settled: 3, deviation: 52.3, miss: false, ratio: null });
    expect(
      readTurnReply(200, {
        settled: 1,
        deviation: null,
        miss: false,
        calibration: "uncalibrated",
        ratio: 0.8,
      }),
    ).toEqual({ kind: "settled", settled: 1, deviation: null, miss: false, ratio: 0.8 });
  });

  it("409 out_of_order と run_closed は settled つき", () => {
    expect(readTurnReply(409, { error: "out_of_order", settled: 2 })).toEqual({
      kind: "out_of_order",
      settled: 2,
    });
    expect(readTurnReply(409, { error: "run_closed", settled: 5 })).toEqual({
      kind: "closed",
      settled: 5,
    });
  });

  it("それ以外のステータスと、settled の読めない応答は「応答なし」と同じ（送り直す）", () => {
    for (const [status, body] of [
      [500, { error: "x" }],
      [422, { error: "invalid_result", reason: "frames" }],
      [404, { error: "run_not_found" }],
      [400, { error: "invalid_device" }],
      [200, null],
      [200, { settled: "3" }],
      [200, { settled: -1 }],
      [409, { error: "other", settled: 1 }],
      [409, { error: "out_of_order" }],
    ] as const) {
      expect(readTurnReply(status, body), `${status}`).toEqual({ kind: "failed" });
    }
  });
});

describe("readReport（POST /runs/{id}/finish の 200）", () => {
  const body = {
    run_id: ID,
    mode: "endless",
    ended: "lives",
    reached: 2,
    avg_deviation: 48.5,
    symbols: null,
    turns: [
      { turn: 0, post_id: ID, kind: "ok", deviation: 55, ratio: null, is_new: false, speed: 1 },
      { turn: 1, post_id: ID, kind: "skip", deviation: null, ratio: null, is_new: true, speed: 1 },
    ],
  };

  it("成績表を読む", () => {
    expect(readReport(body)).toEqual(body);
  });

  it("形が違えば null", () => {
    for (const bad of [
      null,
      { ...body, ended: "won" },
      { ...body, mode: "x" },
      { ...body, reached: "2" },
      { ...body, turns: "x" },
      { ...body, turns: [{ ...body.turns[0], kind: "x" }] },
      { ...body, turns: [{ ...body.turns[0], post_id: 1 }] },
    ]) {
      expect(readReport(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
