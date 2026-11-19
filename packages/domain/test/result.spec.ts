import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_MIN_FRAMES_RATIO,
  DISTRIBUTION_WINDOW,
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

describe("ratioOf: 表示用の値（sc#A.2）", () => {
  it("校正中の ratio は min(1, score / target)", () => {
    expect(ratioOf(6, 12)).toBe(0.5);
    expect(ratioOf(12, 12)).toBe(1);
    expect(ratioOf(30, 12)).toBe(1);
    expect(ratioOf(0, 12)).toBe(0);
  });
});
