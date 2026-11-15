import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_PLAYS,
  calibrationCheck,
  checkResult,
  DISTRIBUTION_MIN_FRAMES_RATIO,
  DISTRIBUTION_WINDOW,
  entersDistribution,
  type IssuedSession,
  isMiss,
  RESULT_EXPIRY_MS,
  ratioOf,
  SCORE_MAX,
  ZERO_STUCK_RATIO,
} from "../src/index.ts";

const ISSUED = Date.UTC(2026, 10, 14, 3, 0, 0);
/** 300 フレーム（5 秒）、等速の手番。発行は ISSUED */
const session = (over: Partial<IssuedSession> = {}): IssuedSession => ({
  timeLimit: 300,
  speed: 1,
  issuedAtMs: ISSUED,
  ...over,
});
/** 発行から sec 秒後 */
const at = (sec: number): number => ISSUED + sec * 1000;
/** 通る結果。300 フレームを 10 秒後に送る */
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  score: 12,
  frames: 300,
  via: "guest",
  inputs: [
    [10, "tap", 0.5, 0.5],
    [10, "tap", 0.2, 0.8],
    [300, "tap", 0.1, 0.1],
  ],
  ...over,
});

describe("定数（sc#A.2、A.4、A.7）", () => {
  it("文書の値", () => {
    expect(RESULT_EXPIRY_MS).toBe(30 * 60 * 1000);
    expect(SCORE_MAX).toBe(2 ** 31 - 1);
    expect(DISTRIBUTION_MIN_FRAMES_RATIO).toBe(0.9);
    expect(DISTRIBUTION_WINDOW).toBe(5);
    expect(ZERO_STUCK_RATIO).toBe(0.8);
  });
});

describe("checkResult: 結果の受理条件（sc#A.2）", () => {
  it("R-sc.A2-1 条件をすべて満たす結果は受理され、値がそのまま返る", () => {
    const b = body();
    expect(checkResult(session(), b, at(10))).toEqual({
      ok: true,
      kind: "result",
      score: 12,
      frames: 300,
      via: "guest",
      inputs: b.inputs,
    });
  });

  it("R-sc.A2-1 発行から 30 分ちょうどは受理、1 ms 過ぎたら expired", () => {
    expect(checkResult(session(), body(), ISSUED + RESULT_EXPIRY_MS).ok).toBe(true);
    expect(checkResult(session(), body(), ISSUED + RESULT_EXPIRY_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
      flagged: false,
    });
  });

  it("R-sc.A2-1 score は 0〜2³¹−1 の整数", () => {
    for (const score of [0, SCORE_MAX]) {
      expect(checkResult(session(), body({ score }), at(10)).ok, String(score)).toBe(true);
    }
    for (const score of [-1, SCORE_MAX + 1, 1.5, "12", null, undefined, Number.NaN]) {
      expect(checkResult(session(), body({ score }), at(10)), String(score)).toEqual({
        ok: false,
        reason: "score",
        flagged: false,
      });
    }
  });

  it("R-sc.A2-1 frames は 1〜time_limit の整数", () => {
    for (const frames of [1, 300]) {
      const r = checkResult(session(), body({ frames, inputs: [] }), at(10));
      expect(r.ok, String(frames)).toBe(true);
    }
    for (const frames of [0, 301, 2.5, "300", undefined]) {
      expect(checkResult(session(), body({ frames, inputs: [] }), at(10)), String(frames)).toEqual({
        ok: false,
        reason: "frames",
        flagged: false,
      });
    }
  });

  it("R-sc.A2-1 入力ログの frame が減る・frames を超えるなら拒否して flagged", () => {
    const flagged = { ok: false, reason: "inputs", flagged: true };
    const decreasing = [
      [20, "tap", 0.5, 0.5],
      [19, "tap", 0.5, 0.5],
    ];
    expect(checkResult(session(), body({ inputs: decreasing }), at(10))).toEqual(flagged);
    // 最大値は frames 以下。frames と同じは通り、1 超えると落ちる
    const last = (frame: number) => [[frame, "tap", 0.5, 0.5]];
    expect(checkResult(session(), body({ frames: 200, inputs: last(200) }), at(10)).ok).toBe(true);
    expect(checkResult(session(), body({ frames: 200, inputs: last(201) }), at(10))).toEqual(
      flagged,
    );
    // 空のログは通る（入力しなかった）
    expect(checkResult(session(), body({ inputs: [] }), at(10)).ok).toBe(true);
  });

  it("R-sc.A2-1 入力ログが配列でない・要素の先頭が非負整数のフレームでないなら拒否して flagged", () => {
    for (const inputs of [undefined, null, "x", {}, [1], [[]], [[-1, "tap"]], [[1.5, "tap"]]]) {
      expect(checkResult(session(), body({ inputs }), at(10)), JSON.stringify(inputs)).toEqual({
        ok: false,
        reason: "inputs",
        flagged: true,
      });
    }
  });

  it("R-sc.A2-1 frames ÷ (60 × speed) が経過秒 × 1.05 ＋ 3 を超えたら拒否して flagged", () => {
    // 300 フレーム等速 = 5 秒。経過 t 秒で 5 ≤ 1.05t + 3 ⇔ t ≥ 1.9048
    expect(checkResult(session(), body(), at(1.905)).ok).toBe(true);
    expect(checkResult(session(), body(), at(1.904))).toEqual({
      ok: false,
      reason: "realtime",
      flagged: true,
    });
    // 速度 1.5 なら同じ 300 フレームは 3.333 秒。経過 0.32 秒で通る（3.333 ≤ 3.336）
    expect(checkResult(session({ speed: 1.5 }), body(), at(0.32)).ok).toBe(true);
    expect(checkResult(session({ speed: 1.5 }), body(), at(0.31)).ok).toBe(false);
  });

  it("R-sc.A2-1 via は guest / timeout / error。timeout / error は score = 0 だけ", () => {
    for (const via of ["timeout", "error"]) {
      expect(checkResult(session(), body({ via, score: 0 }), at(10)).ok, via).toBe(true);
      expect(checkResult(session(), body({ via, score: 1 }), at(10)), via).toEqual({
        ok: false,
        reason: "via",
        flagged: false,
      });
    }
    for (const via of ["host", "", undefined, null, 1]) {
      expect(checkResult(session(), body({ via }), at(10)), String(via)).toEqual({
        ok: false,
        reason: "via",
        flagged: false,
      });
    }
  });

  it("R-sc.A2-1 複数の条件に外れたら、表の上にある条件を理由にする", () => {
    const b = body({ score: -1, frames: 999, via: "x" });
    expect(checkResult(session(), b, at(10))).toMatchObject({ reason: "score" });
    expect(checkResult(session(), b, at(31 * 60))).toMatchObject({ reason: "expired" });
  });

  it("R-sc.A2-1 本文が {skipped: true} だけなら読み込みの skip。期限だけを見る（#136）", () => {
    expect(checkResult(session(), { skipped: true }, at(0))).toEqual({ ok: true, kind: "skipped" });
    expect(checkResult(session(), { skipped: true }, ISSUED + RESULT_EXPIRY_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
      flagged: false,
    });
    // ほかの項目が付いていれば skip ではなく結果として検査する
    expect(checkResult(session(), { skipped: true, frames: 300 }, at(10))).toMatchObject({
      ok: false,
      reason: "score",
    });
    expect(checkResult(session(), { skipped: false }, at(10))).toMatchObject({ ok: false });
  });
});

describe("isMiss / ratioOf: 表示用の値（sc#A.2、run#A.7）", () => {
  it("R-run.A7-1 サーバは凍結した miss_below で判定し直す: score < miss_below のときだけミス", () => {
    expect(isMiss({ via: "guest", score: 29, missBelow: 30 })).toBe(true);
    expect(isMiss({ via: "guest", score: 30, missBelow: 30 })).toBe(false);
    // miss_below が 0 ならミスは起きない（sc#A.6）
    expect(isMiss({ via: "guest", score: 0, missBelow: 0 })).toBe(false);
  });

  it("R-run.A7-1 miss_below が null（新作枠・校正中・デイリー）と timeout / error はミスにならない", () => {
    expect(isMiss({ via: "guest", score: 0, missBelow: null })).toBe(false);
    expect(isMiss({ via: "timeout", score: 0, missBelow: 30 })).toBe(false);
    expect(isMiss({ via: "error", score: 0, missBelow: 30 })).toBe(false);
  });

  it("校正中の ratio は min(1, score / target)", () => {
    expect(ratioOf(6, 12)).toBe(0.5);
    expect(ratioOf(12, 12)).toBe(1);
    expect(ratioOf(30, 12)).toBe(1);
    expect(ratioOf(0, 12)).toBe(0);
  });
});

describe("entersDistribution: 分布に入る条件（sc#A.4）", () => {
  const ok = {
    verdict: "provisional",
    speed: 1,
    author: false,
    frames: 300,
    timeLimit: 300,
  } as const;

  it("R-sc.A4-1 provisional / accepted、等速、作者以外、短縮なしの結果は入る", () => {
    expect(entersDistribution(ok)).toBe(true);
    expect(entersDistribution({ ...ok, verdict: "accepted" })).toBe(true);
  });

  it("R-sc.A4-1 rejected / flagged は入らない", () => {
    expect(entersDistribution({ ...ok, verdict: "rejected" })).toBe(false);
    expect(entersDistribution({ ...ok, verdict: "flagged" })).toBe(false);
  });

  it("R-sc.A4-1 speed > 1.0 は入らない", () => {
    expect(entersDistribution({ ...ok, speed: 1.125 })).toBe(false);
    expect(entersDistribution({ ...ok, speed: 1.5 })).toBe(false);
  });

  it("R-sc.A4-1 作者の結果は入らない", () => {
    expect(entersDistribution({ ...ok, author: true })).toBe(false);
  });

  it("R-sc.A4-1 frames が time_limit の 9 割ちょうどは入り、1 フレーム足りないと入らない", () => {
    expect(entersDistribution({ ...ok, frames: 270 })).toBe(true);
    expect(entersDistribution({ ...ok, frames: 269 })).toBe(false);
    // 0.9 × 255 = 229.5。229 は入らず 230 は入る
    expect(entersDistribution({ ...ok, timeLimit: 255, frames: 229 })).toBe(false);
    expect(entersDistribution({ ...ok, timeLimit: 255, frames: 230 })).toBe(true);
  });
});

describe("calibrationCheck: 校正の検査（sc#A.7）", () => {
  const spread = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("R-sc.A7-1 20 件で検査を通れば calibrated、19 件では決まらない", () => {
    expect(calibrationCheck(spread(CALIBRATION_MIN_PLAYS))).toBe("calibrated");
    expect(calibrationCheck(spread(CALIBRATION_MIN_PLAYS - 1))).toBe(null);
    expect(calibrationCheck([])).toBe(null);
  });

  it("R-sc.A7-1 分散ゼロ（全件同じ点）は invalid", () => {
    expect(calibrationCheck(Array(20).fill(7))).toBe("invalid");
    expect(calibrationCheck(Array(20).fill(0))).toBe("invalid");
    // 19 件が同じでも 1 件違えば分散ゼロではない
    expect(calibrationCheck([...Array(19).fill(7), 8])).toBe("calibrated");
  });

  it("R-sc.A7-1 0 張り付き: 0 の割合が 80% ちょうどで invalid、それ未満は通る", () => {
    const zeros = (z: number, n: number) => [
      ...Array(z).fill(0),
      ...spread(n - z).map((v) => v + 1),
    ];
    expect(calibrationCheck(zeros(16, 20))).toBe("invalid");
    expect(calibrationCheck(zeros(15, 20))).toBe("calibrated");
    expect(calibrationCheck(zeros(20, 25))).toBe("invalid");
    expect(calibrationCheck(zeros(19, 25))).toBe("calibrated");
  });
});
