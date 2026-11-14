import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_PLAYS,
  deviation,
  inverseNormal,
  MISS_DEVIATION,
  missBelow,
} from "../src/index.ts";
// verification/scoring_vectors.py が、scoring_check.py と同じ種の分布から書き出した参照値
import { DEVIATION_VECTORS as vectors } from "./fixtures/deviation-vectors.gen.ts";

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("inverseNormal（sc#A.5 の 3、Acklam）", () => {
  it("中央は 0、Φ(−1) は −1", () => {
    expect(inverseNormal(0.5)).toBe(0);
    expect(inverseNormal(0.158655)).toBeCloseTo(-1, 5);
    expect(inverseNormal(0.841345)).toBeCloseTo(1, 5);
  });

  it("裾（p < 0.02425 と p > 0.97575）でも対称", () => {
    expect(inverseNormal(0.001)).toBeCloseTo(-3.090232, 5);
    expect(inverseNormal(0.999)).toBeCloseTo(3.090232, 5);
  });

  it("0 と 1 は受け付けない", () => {
    expect(() => inverseNormal(0)).toThrow(RangeError);
    expect(() => inverseNormal(1)).toThrow(RangeError);
  });
});

describe("deviation（R-sc.A5-1、sc#A.5）", () => {
  it("定数は文書の値", () => {
    expect(CALIBRATION_MIN_PLAYS).toBe(20);
    expect(MISS_DEVIATION).toBe(40);
  });

  it.each(vectors.map((v) => [v.name, v] as const))("参照実装と同じ値を返す [%s]", (_name, v) => {
    for (const [score, expected] of v.deviations) {
      expect(deviation(score, v.dist), `score=${score}`).toBe(expected);
    }
  });

  it("S1: 点数が高いほど偏差値は高いか等しい。S2: 20〜80 に収まる", () => {
    for (const v of vectors) {
      let prev = 0;
      for (const [score] of v.deviations) {
        const d = deviation(score, v.dist);
        expect(d).toBeGreaterThanOrEqual(prev);
        expect(d).toBeGreaterThanOrEqual(20);
        expect(d).toBeLessThanOrEqual(80);
        prev = d;
      }
    }
  });

  it("S3: n が小さいほど上限が低い（n=20 で 69.8、n=100 で 75.8、n=1000 で 80）", () => {
    expect(deviation(1e9, range(20))).toBe(69.8);
    expect(deviation(1e9, range(100))).toBe(75.8);
    expect(deviation(1e9, range(1000))).toBe(80);
  });

  it("同点は同じ値で、同点の半分を下に数える", () => {
    // n = 4、L = 1、E = 2 → p = (1 + 1 + 0.5) / 5 = 0.5
    expect(deviation(5, [1, 5, 5, 9])).toBe(50);
  });

  it("分布が空なら 50", () => {
    expect(deviation(123, [])).toBe(50);
  });

  it("全件同点の分布では、同点は 50、上は高く、下は低い", () => {
    const dist = Array.from({ length: 500 }, () => 7);
    expect(deviation(7, dist)).toBe(50);
    expect(deviation(8, dist)).toBe(80);
    expect(deviation(6, dist)).toBe(20);
  });
});

describe("missBelow（R-sc.A6-1、sc#A.6）", () => {
  const s4 = (dist: readonly number[]): void => {
    const mb = missBelow(dist);
    const top = dist.length === 0 ? 0 : (dist[dist.length - 1] as number);
    for (let s = 0; s <= top + 2; s++) {
      expect(s < mb, `score=${s} miss_below=${mb}`).toBe(deviation(s, dist) < MISS_DEVIATION);
    }
  };

  it.each(vectors.map((v) => [v.name, v] as const))("参照実装と同じ値を返す [%s]", (_name, v) => {
    expect(missBelow(v.dist)).toBe(v.miss_below);
  });

  it.each(vectors.map((v) => [v.name, v] as const))(
    "S4: score < miss_below ⇔ 偏差値 < 40 [%s]",
    (_name, v) => {
      s4(v.dist);
    },
  );

  it("S4: n = 20〜60 の境界（点数がすべて異なる分布）", () => {
    for (let n = 20; n <= 60; n++) s4(range(n));
  });

  it("分布の 16% 以上が 0 なら 0（ミスが起きない）", () => {
    expect(missBelow([0, 0, 0, 0, 10, 20, 30, 40, 50, 60])).toBe(0);
  });

  it("分布が空なら 0", () => {
    expect(missBelow([])).toBe(0);
  });

  it("分布に無い点数（現れる点数 + 1）が閾値になることがある", () => {
    // 全件 7 点: 6 以下は偏差値 20、7 は 50。閾値は 7
    expect(missBelow(Array.from({ length: 30 }, () => 7))).toBe(7);
    // 0 が 3 件、100 が 27 件: 0 は p = 2/31 で 40 未満、1 は p = 3.5/31 で 40 未満ではない…を計算で確かめる
    const dist = [0, 0, 0, ...Array.from({ length: 27 }, () => 100)];
    const mb = missBelow(dist);
    expect(deviation(mb, dist)).toBeGreaterThanOrEqual(MISS_DEVIATION);
    if (mb > 0) expect(deviation(mb - 1, dist)).toBeLessThan(MISS_DEVIATION);
  });
});
