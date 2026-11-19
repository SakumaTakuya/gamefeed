import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_MIN_FRAMES_RATIO,
  DISTRIBUTION_WINDOW,
  isMiss,
  ratioOf,
  SCORE_MAX,
  ZERO_STUCK_RATIO,
} from "../src/index.ts";

describe("定数（sc#A.2、A.4、A.7）", () => {
  it("文書の値", () => {
    expect(SCORE_MAX).toBe(2 ** 31 - 1);
    expect(DISTRIBUTION_MIN_FRAMES_RATIO).toBe(0.9);
    expect(DISTRIBUTION_WINDOW).toBe(5);
    expect(ZERO_STUCK_RATIO).toBe(0.8);
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
