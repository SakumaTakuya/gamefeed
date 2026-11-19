import { describe, expect, it } from "vitest";
import {
  DAILY_TURN_LIMIT,
  ENDLESS_DECK_SIZE,
  ENDLESS_LIVES,
  ENDLESS_TURN_LIMIT,
  turnSpeed,
} from "../src/index.ts";

describe("定数（run#A.2）", () => {
  it("文書の値", () => {
    expect(ENDLESS_DECK_SIZE).toBe(12);
    expect(ENDLESS_TURN_LIMIT).toBe(50);
    expect(DAILY_TURN_LIMIT).toBe(10);
    expect(ENDLESS_LIVES).toBe(3);
  });
});

describe("turnSpeed（R-run.A8-1、run#A.8）", () => {
  it("エンドレスは周回 k で min(1.5, 1 + 0.125k)", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((k) => turnSpeed("endless", k))).toEqual([
      1, 1.125, 1.25, 1.375, 1.5, 1.5, 1.5,
    ]);
  });

  it("デイリーは常に 1.0", () => {
    expect([0, 1, 5].map((k) => turnSpeed("daily", k))).toEqual([1, 1, 1]);
  });
});
