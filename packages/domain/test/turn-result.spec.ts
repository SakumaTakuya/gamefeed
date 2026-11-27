import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_PLAYS,
  calibrationVerdict,
  checkPlayed,
  FAILURE_RATE_INVALID,
  hostRealtimeOk,
  INVALID_MIN_PLAYS,
  playedSeconds,
  readTurnResult,
  SCORE_MAX,
  serverRealtimeOk,
  tallyOf,
} from "../src/index.ts";

describe("readTurnResult: 本文の 4 つの形（sc#A.2。R-sc.A2-1）", () => {
  it("遊んだ結果・満了・error・読み込みの skip", () => {
    expect(readTurnResult({ via: "guest", score: 3, frames: 10, inputs: [] })).toEqual({
      via: "guest",
      score: 3,
      frames: 10,
      inputs: [],
    });
    expect(readTurnResult({ via: "timeout" })).toEqual({ via: "timeout" });
    expect(readTurnResult({ via: "error" })).toEqual({ via: "error" });
    expect(readTurnResult({ via: "noload" })).toEqual({ via: "noload" });
  });

  it("どの形でもなければ null（API は 400）", () => {
    for (const body of [
      null,
      "x",
      [],
      {},
      { skipped: true },
      { via: "other" },
      { via: "timeout", score: 0 },
      { via: "error", frames: 0 },
      { via: "noload", inputs: [] },
      { via: "guest", score: 1, frames: 1 },
      { via: "guest", score: 1, inputs: [] },
      { via: "guest", frames: 1, inputs: [] },
      { via: "guest", score: 1, frames: 1, inputs: [], extra: 1 },
    ]) {
      expect(readTurnResult(body)).toBeNull();
    }
  });

  it("値の中身は見ない（述語の仕事）", () => {
    expect(readTurnResult({ via: "guest", score: "x", frames: -1, inputs: 0 })).toEqual({
      via: "guest",
      score: "x",
      frames: -1,
      inputs: 0,
    });
  });
});

describe("checkPlayed: 遊んだ結果の述語（sc#A.2 の 3〜5 行目。Host とサーバで同じ）", () => {
  const ok = {
    score: 5,
    frames: 300,
    inputs: [
      [0, "d"],
      [10, "u"],
      [10, "d"],
      [300, "u"],
    ],
  };

  it("満たせば null", () => {
    expect(checkPlayed(ok, 300)).toBeNull();
    expect(checkPlayed({ score: 0, frames: 0, inputs: [] }, 300)).toBeNull();
    expect(checkPlayed({ score: SCORE_MAX, frames: 300, inputs: [] }, 300)).toBeNull();
  });

  it("frames は 0 を通す（#162。下限 1 は無い）", () => {
    expect(checkPlayed({ score: 7, frames: 0, inputs: [] }, 300)).toBeNull();
    expect(checkPlayed({ score: 7, frames: 0, inputs: [[0, "d"]] }, 300)).toBeNull();
  });

  it("score: 整数で 0〜2^31−1", () => {
    for (const score of [-1, SCORE_MAX + 1, 1.5, "1", null, Number.NaN]) {
      expect(checkPlayed({ ...ok, score }, 300)).toBe("score");
    }
  });

  it("frames: 整数で 0〜time_limit", () => {
    for (const frames of [-1, 301, 1.5, "1", null]) {
      expect(checkPlayed({ ...ok, inputs: [], frames }, 300)).toBe("frames");
    }
  });

  it("inputs: 配列で、frame が単調非減少、最大値が frames 以下", () => {
    for (const inputs of [null, {}, [1], [[]], [["0"]], [[-1]], [[5], [4]], [[301]], [[1.5]]]) {
      expect(checkPlayed({ score: 1, frames: 300, inputs }, 300)).toBe("inputs");
    }
    expect(checkPlayed({ score: 1, frames: 9, inputs: [[10]] }, 300)).toBe("inputs");
  });

  it("複数に外れたら表で上にある条件", () => {
    expect(checkPlayed({ score: -1, frames: -1, inputs: null }, 300)).toBe("score");
    expect(checkPlayed({ score: 1, frames: -1, inputs: null }, 300)).toBe("frames");
  });
});

describe("実時間（sc#A.2 の 6 行目。R-sc.A2-1、R-sc.A2-2）", () => {
  it("playedSeconds は frames ÷ (60 × speed)", () => {
    expect(playedSeconds(300, 1)).toBe(5);
    expect(playedSeconds(300, 1.5)).toBeCloseTo(300 / 90, 12);
  });

  it("Host: 走っていた秒 × 1.05 ＋ 0.1 以下", () => {
    // 5 秒ぶんのフレームは、(5 − 0.1) ÷ 1.05 ≈ 4.667 秒走っていれば通る
    expect(hostRealtimeOk(300, 1, 4.67)).toBe(true);
    expect(hostRealtimeOk(300, 1, 4.66)).toBe(false);
    expect(hostRealtimeOk(0, 1, 0)).toBe(true);
    expect(hostRealtimeOk(6, 1, 0)).toBe(true);
    expect(hostRealtimeOk(7, 1, 0)).toBe(false);
    expect(hostRealtimeOk(450, 1.5, 4.67)).toBe(true);
  });

  it("開始直後に frames = time_limit を名乗る end は通らない", () => {
    expect(hostRealtimeOk(300, 1, 0.01)).toBe(false);
  });

  it("サーバ: 遊んだ結果の合計が、経過秒 × 1.05 ＋ 0.1 × 件数 ＋ 3 以下", () => {
    // 10 件、合計 50 秒ぶん。50 ≤ E × 1.05 + 1 + 3 ⇔ E ≥ 43.81
    expect(serverRealtimeOk({ playedSec: 50, count: 10, elapsedSec: 43.9 })).toBe(true);
    expect(serverRealtimeOk({ playedSec: 50, count: 10, elapsedSec: 43.7 })).toBe(false);
    expect(serverRealtimeOk({ playedSec: 0, count: 0, elapsedSec: 0 })).toBe(true);
  });

  it("Host の式を満たす手番の列は、サーバの式を満たす（手番は重ならず、ランの作成より後に走る）", () => {
    let x = 20261115;
    const rnd = () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
    const speeds = [1, 1.125, 1.25, 1.375, 1.5];
    for (let run = 0; run < 2000; run++) {
      let elapsedSec = rnd() * 2; // ランの作成から最初の手番まで
      let playedSec = 0;
      let count = 0;
      const turns = 1 + Math.floor(rnd() * 50);
      for (let t = 0; t < turns; t++) {
        const speed = speeds[Math.floor(rnd() * speeds.length)] as number;
        const ranSec = rnd() * 12;
        // Host が受け取る最大の frames を名乗る
        const frames = Math.floor((ranSec * 1.05 + 0.1) * 60 * speed);
        expect(hostRealtimeOk(frames, speed, ranSec)).toBe(true);
        elapsedSec += ranSec + rnd() * 3; // 幕間・pause・通信
        playedSec += playedSeconds(frames, speed);
        count++;
        expect(serverRealtimeOk({ playedSec, count, elapsedSec })).toBe(true);
      }
    }
  });
});

describe("tallyOf: 結果の行き先（sc#A.4。R-sc.A4-1）", () => {
  // 作者かどうかは受け取らない。作者がランで遊んだ結果も同じに数える（sc#B.5、#242）
  const base = { verdict: "provisional" as const, speed: 1, timeLimit: 300 };

  it("遊んだ結果は分布へ", () => {
    expect(tallyOf({ ...base, via: "guest", frames: 300 })).toBe("distribution");
    expect(tallyOf({ ...base, via: "guest", frames: 270 })).toBe("distribution");
    expect(tallyOf({ ...base, via: "guest", frames: 300, verdict: "accepted" })).toBe(
      "distribution",
    );
  });

  it("遊んだ結果でも、条件に外れればどこにも入らない", () => {
    expect(tallyOf({ ...base, via: "guest", frames: 269 })).toBeNull();
    expect(tallyOf({ ...base, via: "guest", frames: 300, speed: 1.125 })).toBeNull();
    expect(tallyOf({ ...base, via: "guest", frames: 300, verdict: "rejected" })).toBeNull();
    expect(tallyOf({ ...base, via: "guest", frames: 300, verdict: "flagged" })).toBeNull();
  });

  it("満了と error は失敗の数へ（frames の条件は無い）。分布には入らない", () => {
    expect(tallyOf({ ...base, via: "timeout" })).toBe("failure");
    expect(tallyOf({ ...base, via: "error" })).toBe("failure");
  });

  it("満了と error も、等速でない・作者のものは数えない", () => {
    expect(tallyOf({ ...base, via: "timeout", speed: 1.5 })).toBeNull();
  });

  it("読み込みの skip はどちらにも入らない", () => {
    expect(tallyOf({ ...base, via: "noload" })).toBeNull();
  });
});

describe("calibrationVerdict: 校正の検査（sc#A.7、B.12。R-sc.A7-1）", () => {
  const spread = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("校正は 5 件、invalid は 20 件から（どちらも暫定）", () => {
    expect(CALIBRATION_MIN_PLAYS).toBe(5);
    expect(INVALID_MIN_PLAYS).toBe(20);
    expect(FAILURE_RATE_INVALID).toBe(0.5);
  });

  it("n が 5 に満たなければ決まらない", () => {
    expect(calibrationVerdict([], 0)).toBeNull();
    expect(calibrationVerdict(spread(4), 0)).toBeNull();
    expect(calibrationVerdict(spread(4), 3)).toBeNull();
  });

  it("n ≥ 5 で検査に当たらなければ calibrated（1 人の 5 件で届く）", () => {
    expect(calibrationVerdict(spread(5), 0)).toBe("calibrated");
    expect(calibrationVerdict(spread(5), 4)).toBe("calibrated");
    expect(calibrationVerdict(spread(19), 0)).toBe("calibrated");
    expect(calibrationVerdict(spread(20), 19)).toBe("calibrated");
    expect(calibrationVerdict(spread(51), 49)).toBe("calibrated");
  });

  it("20 件に満たない間は、検査に当たる分布を calibrated にも invalid にもしない", () => {
    // 失敗率 50% 以上
    expect(calibrationVerdict(spread(5), 5)).toBeNull();
    expect(calibrationVerdict(spread(9), 10)).toBeNull();
    expect(calibrationVerdict([], 19)).toBeNull();
    // 分散ゼロ（0 と 1 のゲームを 5 回成功させただけ、を invalid にしない）
    expect(calibrationVerdict(Array(5).fill(1), 0)).toBeNull();
    expect(calibrationVerdict(Array(19).fill(7), 0)).toBeNull();
    // 0 張り付き（80% 以上）
    expect(calibrationVerdict([0, 0, 0, 0, 3], 0)).toBeNull();
    expect(calibrationVerdict([0, 0, 0, 2, 3], 0)).toBe("calibrated");
    // 分布が 20 件に満たない間は、失敗を足して 20 件でも分布の形では決めない
    expect(calibrationVerdict(Array(15).fill(7), 5)).toBeNull();
  });

  it("失敗率 50% 以上は、n + f ≥ 20 で invalid。n が 20 に満たなくても", () => {
    expect(calibrationVerdict(spread(10), 10)).toBe("invalid");
    expect(calibrationVerdict([], 20)).toBe("invalid");
    expect(calibrationVerdict(spread(20), 20)).toBe("invalid");
  });

  it("分散ゼロと 0 張り付きは、n ≥ 20 で invalid", () => {
    expect(calibrationVerdict(Array(20).fill(7), 0)).toBe("invalid");
    expect(calibrationVerdict([...Array(16).fill(0), 1, 2, 3, 4], 0)).toBe("invalid");
    expect(calibrationVerdict([...Array(15).fill(0), 1, 2, 3, 4, 5], 0)).toBe("calibrated");
  });

  it("失敗は 0 点として数えない（0 張り付きの検査に混ざらない）", () => {
    expect(calibrationVerdict(spread(20), 19)).toBe("calibrated");
  });
});
