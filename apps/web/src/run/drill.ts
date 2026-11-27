// ドリルの絵の計算（host-design#A.6 の印、A.7 のめくりの形）。DOM に触らない。描くのは `RunPage.tsx`。

/** 採点の印（hd#A.6）。✕・△・○・花丸 */
export type Mark = "batsu" | "sankaku" | "maru" | "hanamaru";

/**
 * 印を決める。Host は偏差値を推測しない。
 * - ミスは、応答の偏差値が何であっても ✕（凍結した `miss_below` が正。run#A.7）
 * - ミスでなければ、応答の偏差値が届いてから 花丸（60 以上）・○（50 以上）・△（それ未満）
 * - 校正中・新作枠・skip・応答がまだ、は印なし（null）
 */
export function markOf(r: { miss: boolean; deviation: number | null }): Mark | null {
  if (r.miss) return "batsu";
  if (r.deviation === null) return null;
  if (r.deviation >= 60) return "hanamaru";
  if (r.deviation >= 50) return "maru";
  return "sankaku";
}

/** めくりの長さ（ms。暫定）。幕間 1.0 秒の内側で終わる（hd#A.7） */
export const FLIP_MS = 620;
/** 動きを減らす設定のとき、めくる代わりに重ねて入れ替える長さ（ms。暫定） */
export const REDUCED_SWAP_MS = 150;
/** 印を一筆で描く長さ（ms。暫定） */
export const MARK_MS = 380;

export type Point = readonly [number, number];
/** CSS の `matrix(a, b, c, d, e, f)` の 6 値 */
export type Matrix = readonly [number, number, number, number, number, number];

export interface Fold {
  /** 表: めくられる紙のうち、そのまま見せる部分（舞台の座標、px）。無ければ空 */
  front: Point[];
  /** 裏: 折り返される部分の、折り返す前の形。`mirror` を掛けた先に紙の裏を描く。無ければ空 */
  back: Point[];
  /** 折り目での鏡映し */
  mirror: Matrix;
  /** 折り目。`point` は折り目の上の 1 点、`normal` は折り返される側（角の側）を向く単位ベクトル */
  crease: { point: Point; normal: Point };
}

/** めくりの進み方。2 次の ease-in-out */
export function flipEase(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
}

export function polygonArea(pts: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Point;
    const b = pts[(i + 1) % pts.length] as Point;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

export function mirrorPoint(m: Matrix, p: Point): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** 凸多角形を、`side(p) >= 0` の側だけに切る */
function clip(pts: readonly Point[], side: (p: Point) => number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Point;
    const b = pts[(i + 1) % pts.length] as Point;
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if (sa >= 0 !== sb >= 0) {
      const k = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * めくりの途中 `t`（0〜1）の形。舞台は幅 `w`・高さ `h`、左上が原点、上の辺が綴じ目。
 *
 * 右下の角 C = (w, h) を P(θ) = (w − 0.5·h·sin θ, h·cos θ)、θ = π·flipEase(t) に運ぶ。
 * 折り目は C と P の垂直二等分線。P は右上の角から h 以内、左上の角から対角線の長さ以内にあるので、
 * 上の辺は最後まで折れない（hd#A.7、H2）。
 */
export function pageFold(t: number, w: number, h: number): Fold {
  const rect: Point[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const e = flipEase(t);
  if (e <= 0) {
    return { front: rect, back: [], mirror: IDENTITY, crease: { point: [w, h], normal: [0, 1] } };
  }
  const th = Math.PI * e;
  // e = 1 のとき sin π が 0 にならない誤差を消す
  const px = w - 0.5 * h * (e >= 1 ? 0 : Math.sin(th));
  const py = h * (e >= 1 ? -1 : Math.cos(th));
  const dx = w - px;
  const dy = h - py;
  const len = Math.hypot(dx, dy);
  const nx = dx / len;
  const ny = dy / len;
  // 折り目の位置: 中点を法線に射影した値
  const mn = ((w + px) / 2) * nx + ((h + py) / 2) * ny;
  const side = (p: Point) => p[0] * nx + p[1] * ny - mn;
  const mirror: Matrix = [
    1 - 2 * nx * nx,
    -2 * nx * ny,
    -2 * nx * ny,
    1 - 2 * ny * ny,
    2 * mn * nx,
    2 * mn * ny,
  ];
  const crease = { point: [mn * nx, mn * ny] as Point, normal: [nx, ny] as Point };
  if (e >= 1) return { front: [], back: rect, mirror, crease };
  const front = clip(rect, (p) => -side(p));
  const back = clip(rect, side);
  return {
    front: polygonArea(front) > 1e-9 ? front : [],
    back: polygonArea(back) > 1e-9 ? back : [],
    mirror,
    crease,
  };
}
