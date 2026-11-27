// ドリルの絵の計算（hd#A.6 の印、hd#A.7 のめくりの形）。DOM に触らない。

import { INTERLUDE_MS } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import {
  FLIP_MS,
  flipEase,
  flipFrame,
  type Mark,
  markOf,
  mirrorPoint,
  type Paper,
  pageFold,
  paperOf,
  polygonArea,
  REDUCED_SWAP_MS,
  turnsPage,
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

describe("R-hd.A7-2 どの紙が出ているか、いつめくるか（hd#A.7 の表）", () => {
  it("紙は phase・終わった理由・成績表の有無だけから決まる", () => {
    const at = (phase: string, ended: string | null = null, report = false) =>
      paperOf({ phase, ended, report });
    expect(at("idle")).toBe("cover");
    expect(at("interlude")).toBe("question");
    // 「続きから」の幕間も問題のページ
    expect(at("resuming")).toBe("question");
    expect(at("running")).toBe("game");
    expect(at("flash")).toBe("grading");
    expect(at("closing", "lives")).toBe("end");
    expect(at("finished", "limit")).toBe("end");
    expect(at("finished", "abandoned")).toBe("end");
    expect(at("finished", "lives", true)).toBe("report");
    // 通信エラーは成績表を出さない（run#A.6）
    expect(at("closing", "error")).toBe("notice");
    expect(at("finished", "error", true)).toBe("notice");
  });

  it("めくるのは表の 4 通りだけ", () => {
    const papers: Paper[] = ["cover", "question", "game", "grading", "end", "report", "notice"];
    const turned = papers.flatMap((from) =>
      papers.filter((to) => turnsPage(from, to)).map((to) => `${from} → ${to}`),
    );
    expect(turned.sort()).toEqual(
      ["cover → question", "grading → question", "end → report", "report → question"].sort(),
    );
  });

  it("めくりも、動きを減らす設定の入れ替えも、幕間の内側で終わる", () => {
    expect(FLIP_MS).toBeLessThan(INTERLUDE_MS);
    expect(REDUCED_SWAP_MS).toBeLessThan(FLIP_MS);
    expect(REDUCED_SWAP_MS).toBe(150);
  });
});

describe("R-hd.A7-1 flipFrame（めくりの 1 コマを CSS の値にする。hd#A.7）", () => {
  const W = 360;
  const H = 640;
  const points = (clip: string) =>
    [...clip.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );

  it("t = 0 は紙の全面を見せ、裏も陰影も無い", () => {
    const f = flipFrame(0, W, H);
    expect(polygonArea(points(f.clip))).toBeCloseTo(W * H, 3);
    expect(f.back).toBeNull();
    expect(f.shade).toBe(0);
  });

  it("t = 1 は紙を見せない。裏は綴じ目の上（舞台の外）にある", () => {
    const f = flipFrame(1, W, H);
    expect(f.clip).toMatch(/^polygon\(/);
    expect(polygonArea(points(f.clip))).toBe(0);
    expect(f.shade).toBeCloseTo(0, 9);
  });

  it("途中は pageFold の表を切り抜きに、裏を「折り返す前の形 + 鏡映し」にする", () => {
    for (const t of [0.1, 0.37, 0.5, 0.82]) {
      const fold = pageFold(t, W, H);
      const f = flipFrame(t, W, H);
      expect(f.clip).toMatch(/^polygon\((-?[\d.]+px -?[\d.]+px(, )?){3,}\)$/);
      // 座標を 0.01 px に丸めるので、面積は数 px² までずれる
      expect(polygonArea(points(f.clip)), `t=${t}`).toBeCloseTo(polygonArea(fold.front), -1);
      expect(f.back, `t=${t}`).not.toBeNull();
      expect(polygonArea(points(f.back?.clip ?? "")), `t=${t}`).toBeCloseTo(
        polygonArea(fold.back),
        -1,
      );
      const m = /^matrix\((.+)\)$/
        .exec(f.back?.transform ?? "")?.[1]
        ?.split(", ")
        .map(Number);
      expect(m).toHaveLength(6);
      fold.mirror.forEach((v, i) => {
        expect(m?.[i], `t=${t} m[${i}]`).toBeCloseTo(v, 3);
      });
      // 陰影は折り目の上の 1 点に置き、角の側（法線の向き）へ伸ばす
      const [x, y, deg] = (
        /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) rotate\((-?[\d.]+)deg\)$/.exec(f.crease) ?? []
      )
        .slice(1)
        .map(Number);
      expect(x).toBeCloseTo(fold.crease.point[0], 1);
      expect(y).toBeCloseTo(fold.crease.point[1], 1);
      const rad = ((deg as number) * Math.PI) / 180;
      expect(Math.cos(rad)).toBeCloseTo(fold.crease.normal[0], 3);
      expect(Math.sin(rad)).toBeCloseTo(fold.crease.normal[1], 3);
      expect(f.shade).toBeGreaterThan(0);
      expect(f.shade).toBeLessThanOrEqual(1);
    }
  });
});
