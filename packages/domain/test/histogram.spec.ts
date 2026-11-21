// ゲームページのヒストグラム（product#9 の 5、sc#A.4）。区間の切り方。
import { describe, expect, it } from "vitest";
import { HISTOGRAM_BINS, histogram, histogramIndex } from "../src/index.ts";

const total = (bins: { count: number }[]) => bins.reduce((sum, b) => sum + b.count, 0);

describe("histogram", () => {
  it("R-run.A14-7 空の分布は区間なし。全件同点は 1 本", () => {
    expect(histogram([])).toEqual([]);
    expect(histogram([7, 7, 7])).toEqual([{ from: 7, to: 7, count: 3 }]);
  });

  it("R-run.A14-7 点数の幅が 12 以下なら、点数 1 つが 1 本（間の空きも 0 件の棒として残す）", () => {
    expect(histogram([0, 0, 1, 3])).toEqual([
      { from: 0, to: 0, count: 2 },
      { from: 1, to: 1, count: 1 },
      { from: 2, to: 2, count: 0 },
      { from: 3, to: 3, count: 1 },
    ]);
    const twelve = Array.from({ length: 12 }, (_, i) => i + 5);
    expect(histogram(twelve)).toHaveLength(12);
    expect(histogram(twelve).every((b) => b.from === b.to && b.count === 1)).toBe(true);
  });

  it("R-run.A14-7 幅が広ければ、整数の等幅で 12 本以下に切る。区間はつながっていて、全件がどこかに入る。最後の 1 本は最大の点数で終わる", () => {
    // 10, 20, …, 200。幅 191 → 1 本あたり 16 点
    const dist = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    const bins = histogram(dist);
    expect(bins).toHaveLength(12);
    expect(bins[0]).toEqual({ from: 10, to: 25, count: 2 });
    // 等幅なら 186〜201 だが、だれも取っていない 201 を図の端にしない
    expect(bins[11]).toEqual({ from: 186, to: 200, count: 2 });
    for (let i = 1; i < bins.length; i++) {
      expect(bins[i]?.from).toBe((bins[i - 1]?.to as number) + 1);
    }
    expect(total(bins)).toBe(20);
  });

  it("R-run.A14-7 さまざまな分布で、本数は 12 以下、件数の合計は分布の件数、両端は最小と最大に一致する", () => {
    let a = 12345;
    const rand = () => {
      a = (Math.imul(a, 1103515245) + 12345) >>> 0;
      return a / 4294967296;
    };
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 300);
      const scale = [1, 5, 13, 100, 100000, 2 ** 31 - 1][trial % 6] as number;
      const dist = Array.from({ length: n }, () => Math.floor(rand() ** 3 * scale)).sort(
        (x, y) => x - y,
      );
      const bins = histogram(dist);
      expect(bins.length).toBeGreaterThanOrEqual(1);
      expect(bins.length).toBeLessThanOrEqual(HISTOGRAM_BINS);
      expect(total(bins)).toBe(n);
      expect(bins[0]?.from).toBe(dist[0]);
      expect(bins[bins.length - 1]?.to).toBe(dist[n - 1]);
      for (const b of bins) expect(Number.isSafeInteger(b.from) && b.from <= b.to).toBe(true);
    }
  });

  it("R-run.A14-7 長い尾（外れ値）で全体が 1 本に潰れない: 上位 5% が遠ければ、最後の 1 本にまとめる", () => {
    // 0〜18 が 19 件と、10,000 が 1 件
    const dist = [...Array.from({ length: 19 }, (_, i) => i), 10000];
    const bins = histogram(dist);
    expect(bins.length).toBeGreaterThan(6);
    const last = bins[bins.length - 1];
    expect(last?.to).toBe(10000);
    expect(last?.count).toBeGreaterThanOrEqual(1);
    // 尾の手前は細かいまま
    expect(bins[0]).toEqual({ from: 0, to: 1, count: 2 });
    expect(total(bins)).toBe(20);
  });

  it("R-run.A14-7 尾が近ければ（最大が 95% 点の 3 倍以内）まとめない: 最後の 1 本も、ほかより長くならない", () => {
    const dist = [...Array.from({ length: 19 }, (_, i) => i * 10), 400];
    const bins = histogram(dist);
    const widths = bins.map((b) => b.to - b.from);
    const last = widths.pop() as number;
    expect(new Set(widths).size).toBe(1);
    expect(last).toBeLessThanOrEqual(widths[0] as number);
    expect(bins[bins.length - 1]?.to).toBe(400);
  });
});

describe("histogramIndex（点数の入る棒）", () => {
  const bins = histogram(Array.from({ length: 20 }, (_, i) => (i + 1) * 10));

  it("R-run.A14-7 区間の中の点数はその棒。分布の外の点数は端の棒", () => {
    expect(histogramIndex(bins, 10)).toBe(0);
    expect(histogramIndex(bins, 25)).toBe(0);
    expect(histogramIndex(bins, 26)).toBe(1);
    expect(histogramIndex(bins, 200)).toBe(11);
    expect(histogramIndex(bins, 0)).toBe(0);
    expect(histogramIndex(bins, 99999)).toBe(11);
  });

  it("区間が無ければ null", () => {
    expect(histogramIndex([], 5)).toBeNull();
  });
});
