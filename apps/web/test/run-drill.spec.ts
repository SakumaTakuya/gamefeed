// ドリルの絵の計算（hd#A.6 の印、hd#A.7 のめくりの形）。DOM に触らない。
import { describe, expect, it } from "vitest";
import {
  FLIP_MS,
  flipEase,
  type Mark,
  markOf,
  mirrorPoint,
  pageFold,
  polygonArea,
} from "../src/run/drill.ts";

describe("R-hd.A6-1 markOf（採点の印。hd#A.6、H1）", () => {
  const cases: [boolean, number | null, Mark | null][] = [
    // ミスは、偏差値が何であっても ✕（凍結した miss_below が正）
    [true, null, "batsu"],
    [true, 39, "batsu"],
    [true, 41.2, "batsu"],
    [true, 65, "batsu"],
    // ミスでなければ、応答の偏差値が届くまで印なし
    [false, null, null],
    // ミスでない手番は、偏差値が 40 未満でも △
    [false, 39, "sankaku"],
    [false, 40, "sankaku"],
    [false, 49.9, "sankaku"],
    [false, 50, "maru"],
    [false, 59.9, "maru"],
    [false, 60, "hanamaru"],
    [false, 78.4, "hanamaru"],
  ];
  it.each(cases)("miss=%s deviation=%s → %s", (miss, deviation, mark) => {
    expect(markOf({ miss, deviation })).toBe(mark);
  });
});

describe("R-hd.A7-1 pageFold（めくりの形。hd#A.7、H2）", () => {
  // 9:16 と、縦長の端末（9:19.5）
  const stages: [number, number][] = [
    [360, 640],
    [390, 845],
  ];
  const steps = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);

  it.each(stages)("%d × %d: t = 0 で紙の全面が表。裏は無い", (w, h) => {
    const f = pageFold(0, w, h);
    expect(polygonArea(f.front)).toBeCloseTo(w * h, 6);
    expect(f.back).toEqual([]);
  });

  it.each(stages)("%d × %d: t = 1 で表が残らず、紙の全面が裏返る", (w, h) => {
    const f = pageFold(1, w, h);
    expect(f.front).toEqual([]);
    expect(polygonArea(f.back)).toBeCloseTo(w * h, 6);
    // 全面が綴じ目（上の辺）の上へ返る: 左下の角は (0, -h) に写る
    const p = mirrorPoint(f.mirror, [0, h]);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(-h, 6);
  });

  it.each(stages)("%d × %d: 途中では、表と裏を合わせると紙の全面になり、裏は増える一方", (w, h) => {
    let last = 0;
    for (const t of steps) {
      const f = pageFold(t, w, h);
      const front = polygonArea(f.front);
      const back = polygonArea(f.back);
      expect(front + back, `t=${t}`).toBeCloseTo(w * h, 4);
      expect(back, `t=${t}`).toBeGreaterThanOrEqual(last - 1e-6);
      last = back;
    }
  });

  it.each(stages)("%d × %d: 上の辺（綴じ目）は最後まで折れない", (w, h) => {
    for (const t of steps) {
      const f = pageFold(t, w, h);
      // 裏の側に入る点は、折り目より角の側にある。上の辺のどの点もそこに入らない
      for (const [, y] of f.back) expect(y, `t=${t}`).toBeGreaterThanOrEqual(-1e-6);
      const touchesTop = f.back.filter(([, y]) => y < 1e-6);
      // 上の辺に触れるのは、多くても折り目の端の 1 点（右上の角）だけ
      expect(touchesTop.length, `t=${t}`).toBeLessThanOrEqual(1);
    }
  });

  it.each(stages)(
    "%d × %d: 鏡映しは折り目で折り返す。2 回で元に戻り、右下の角を軌道の点に写す",
    (w, h) => {
      for (const t of [0.1, 0.37, 0.5, 0.82, 0.99]) {
        const f = pageFold(t, w, h);
        const th = Math.PI * flipEase(t);
        const corner = mirrorPoint(f.mirror, [w, h]);
        expect(corner[0]).toBeCloseTo(w - 0.5 * h * Math.sin(th), 6);
        expect(corner[1]).toBeCloseTo(h * Math.cos(th), 6);
        const q: [number, number] = [w * 0.3, h * 0.7];
        const twice = mirrorPoint(f.mirror, mirrorPoint(f.mirror, q));
        expect(twice[0]).toBeCloseTo(q[0], 6);
        expect(twice[1]).toBeCloseTo(q[1], 6);
        // 折り目の上の点は動かない
        const on = mirrorPoint(f.mirror, f.crease.point);
        expect(on[0]).toBeCloseTo(f.crease.point[0], 6);
        expect(on[1]).toBeCloseTo(f.crease.point[1], 6);
      }
    },
  );

  it("t は 0〜1 に丸める。進み方は 2 次の ease-in-out で、時間は 0.62 秒（暫定）", () => {
    expect(pageFold(-1, 360, 640)).toEqual(pageFold(0, 360, 640));
    expect(pageFold(2, 360, 640)).toEqual(pageFold(1, 360, 640));
    expect(flipEase(0)).toBe(0);
    expect(flipEase(0.25)).toBeCloseTo(0.125, 9);
    expect(flipEase(0.5)).toBeCloseTo(0.5, 9);
    expect(flipEase(0.75)).toBeCloseTo(0.875, 9);
    expect(flipEase(1)).toBe(1);
    expect(FLIP_MS).toBe(620);
  });
});
