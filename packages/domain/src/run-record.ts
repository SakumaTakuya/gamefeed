// ランの定数と、周回から決まる値（run#A.2、A.8、sc#A.9）。I/O を持たない。
// 手番の位置・記録の集計は run-plan.ts、Host 側のスロット制御（run#A.4〜A.6）は run.ts。

import { SPEED_MAX, type Speed } from "./session.ts";

export type RunMode = "endless" | "daily";

/** エンドレスの山札の本数（run#A.2。暫定）。出せるゲームが足りなければ短くなる（#123） */
export const ENDLESS_DECK_SIZE = 12;
/** ランの上限（手番）。skip も 1 つと数える（run#B.3） */
export const ENDLESS_TURN_LIMIT = 50;
export const DAILY_TURN_LIMIT = 10;
/** エンドレスの残機（run#A.2） */
export const ENDLESS_LIVES = 3;
/** 周回ごとの速度の上がり幅（run#A.8。暫定） */
export const SPEED_STEP_PER_LAP = 0.125;
/** 記号列の境界（sc#A.9。暫定） */
export const SYMBOL_BOUNDS = [
  [60, "◎"],
  [50, "○"],
  [40, "△"],
] as const;
export const SYMBOL_BELOW = "×";
export const SYMBOL_NONE = "—";

export function turnLimit(mode: RunMode): number {
  return mode === "endless" ? ENDLESS_TURN_LIMIT : DAILY_TURN_LIMIT;
}

/** 周回 lap（0 始まり）の速度（run#A.8）。エンドレスは min(1.5, 1 + 0.125 × lap)、デイリーは 1.0 */
export function turnSpeed(mode: RunMode, lap: number): Speed {
  if (mode === "daily") return 1;
  // 0.125 の倍数は浮動小数で正確に表せるので、5 値のどれかになる
  return Math.min(SPEED_MAX, 1 + SPEED_STEP_PER_LAP * lap) as Speed;
}
