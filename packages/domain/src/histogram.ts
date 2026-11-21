// ゲームページのヒストグラム（product#9 の 5、sc#A.4）。分布を整数の区間に切る。I/O を持たない。

/** 区間の本数の上限（暫定。スマホの幅で棒が読める数） */
export const HISTOGRAM_BINS = 12;
/** 分布の中でこの割合より上を「尾」と見る（暫定） */
const TAIL_QUANTILE = 0.95;
/** 最大が、最小から尾の手前までの幅のこの倍数より遠ければ、尾を最後の 1 本にまとめる（暫定） */
const TAIL_FACTOR = 3;

/** 点数が from 以上 to 以下の結果が count 件 */
export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

/**
 * 分布（点数の**昇順**の配列。sc#A.4）を区間に切る。
 *
 * - 区間は最小の点数から始まり、切れ目なくつながる。本数は `maxBins` 以下。空の分布は区間なし
 * - 幅は整数で、全区間で同じ（点数の幅が `maxBins` 以下なら 1。点数 1 つが 1 本）
 * - 外れ値で全体が 1 本に潰れないよう、上位 5% が遠いときは、手前の 95% を等幅に切り、
 *   最後の 1 本だけ最大の点数まで伸ばす（その 1 本だけ幅が違う）
 */
export function histogram(
  sorted: readonly number[],
  maxBins: number = HISTOGRAM_BINS,
): HistogramBin[] {
  const n = sorted.length;
  if (n === 0) return [];
  const min = sorted[0] as number;
  const max = sorted[n - 1] as number;
  const near = sorted[Math.ceil(TAIL_QUANTILE * n) - 1] as number;
  const tail = near > min && max - min > TAIL_FACTOR * (near - min);
  const top = tail ? near : max;

  const span = top - min + 1;
  const width = Math.ceil(span / maxBins);
  const k = Math.ceil(span / width);
  const bins: HistogramBin[] = Array.from({ length: k }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width - 1,
    count: 0,
  }));
  const last = bins[k - 1] as HistogramBin;
  if (last.to < max) last.to = max;
  for (const score of sorted) {
    (bins[Math.min(k - 1, Math.floor((score - min) / width))] as HistogramBin).count++;
  }
  return bins;
}

/** score の入る区間の位置。分布の外の点数は端の区間。区間が無ければ null */
export function histogramIndex(bins: readonly HistogramBin[], score: number): number | null {
  if (bins.length === 0) return null;
  const i = bins.findIndex((b) => score <= b.to);
  return i === -1 ? bins.length - 1 : i;
}
