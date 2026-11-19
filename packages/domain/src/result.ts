// 結果まわりの定数と、表示用の値（sc#A.2、A.4、A.7）。I/O を持たない。
// 結果の形・述語・行き先・校正の検査は turn-result.ts。

/** score の上限（gc#A.4、sc#A.2） */
export const SCORE_MAX = 2 ** 31 - 1;
/** 実時間の検査の係数と、サーバの式でラン 1 本に許す余裕（秒）（sc#A.2。式は turn-result.ts） */
export const REALTIME_FACTOR = 1.05;
export const REALTIME_SLACK_SEC = 3;
/** 分布に入れる frames の下限（time_limit に対する割合。sc#A.4、暫定） */
export const DISTRIBUTION_MIN_FRAMES_RATIO = 0.9;
/** 1 主体 1 ゲームにつき分布に入る直近の件数（sc#A.4、暫定） */
export const DISTRIBUTION_WINDOW = 5;
/** 0 張り付きで invalid にする 0 の割合（sc#A.7、暫定） */
export const ZERO_STUCK_RATIO = 0.8;

/** 古い Host（run.ts）が使う結果の種類。#158 で `TurnVia`（turn-result.ts）に置き換える */
export type ResultVia = "guest" | "timeout" | "error";

/**
 * 凍結した `miss_below` での判定（sc#A.2、run#A.7）。Host の判定と同じ式。
 * `miss_below` が null の手番と `timeout` / `error`（skip）はミスにならない。
 */
export function isMiss(r: { via: ResultVia; score: number; missBelow: number | null }): boolean {
  return r.via === "guest" && r.missBelow !== null && r.score < r.missBelow;
}

/** 校正中に偏差値の代わりに出す値（sc#A.2）。target は gf:target（1 以上） */
export function ratioOf(score: number, target: number): number {
  return Math.min(1, score / target);
}
