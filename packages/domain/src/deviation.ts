// 偏差値と miss_below（sc#A.5、A.6）。I/O を持たない。
// 参照実装は verification/scoring_check.py。値がずれたら test/deviation.spec.ts が落ちる。

/** 校正に要るプレイ数（product#5.3、sc#A.7）。これ未満は偏差値を出さない */
export const CALIBRATION_MIN_PLAYS = 20;
/** エンドレスでミスになる偏差値の閾値（run#A.2。暫定） */
export const MISS_DEVIATION = 40;
/** 偏差値の下限と上限（sc#A.5 の 4） */
export const DEVIATION_MIN = 20;
export const DEVIATION_MAX = 80;

// Acklam の有理近似（相対誤差 1.15e-9）の係数
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
] as const;
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
] as const;
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const;
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
] as const;
// 中央の式と裾の式の境界。上側は 1 − P_LOW（関数の中で引く。モジュール直下の式は SDK のバンドルに残るため）
const P_LOW = 0.02425;

const tail = (q: number): number =>
  (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
  ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);

/** 標準正規分布の逆関数 Φ⁻¹（sc#A.5 の 3）。0 < p < 1 */
export function inverseNormal(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be in (0, 1)");
  if (p < P_LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - P_LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
  );
}

/** 昇順の配列で、value 以上になる最初の位置 */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 昇順の配列で、value より大きくなる最初の位置 */
function upperBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 結果 score の偏差値（sc#A.5）。
 * dist はそのゲームの分布（sc#A.4）の点数を**昇順**に並べたもので、score 自身の結果は含めない。
 * 校正前（n < CALIBRATION_MIN_PLAYS）に偏差値を出さない判断は呼び出し側が行う。
 */
export function deviation(score: number, dist: readonly number[]): number {
  const n = dist.length;
  const lower = lowerBound(dist, score);
  const equal = upperBound(dist, score) - lower;
  const p = (lower + 0.5 * equal + 0.5) / (n + 1);
  const value = Math.round((50 + 10 * inverseNormal(p)) * 10) / 10;
  return Math.min(DEVIATION_MAX, Math.max(DEVIATION_MIN, value));
}

/**
 * 発行時点の分布に対して、偏差値が MISS_DEVIATION 以上になる最小の点数（sc#A.6）。
 * ミスは score < missBelow。0 ならミスは起きない。dist は昇順。
 *
 * 偏差値は点数について単調非減少で、値が変わるのは分布に現れる点数とその +1 だけなので、
 * その候補を二分探索する。
 */
export function missBelow(dist: readonly number[]): number {
  const candidates: number[] = [0];
  for (const v of dist) {
    for (const c of [v, v + 1]) {
      if (c > (candidates[candidates.length - 1] as number)) candidates.push(c);
    }
  }
  let lo = 0;
  let hi = candidates.length - 1;
  // 最大の候補（最高点 + 1）は p = (n + 0.5) / (n + 1) ≥ 0.5 なので必ず閾値以上
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (deviation(candidates[mid] as number, dist) >= MISS_DEVIATION) hi = mid;
    else lo = mid + 1;
  }
  return candidates[lo] as number;
}
