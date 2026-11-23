/**
 * PoC 環境だけの近道（`poc` ブランチ。main には入れない。docs/poc.md）。
 *
 * 環境変数 `POC_MODE=1` のときだけ効く。無ければこのファイルの関数はどれも何も変えない。
 * 仕様（scoring.md の「20 件で校正」など）とは食い違う。体験を 1 人で確かめるためのもの。
 */
import { CALIBRATION_MIN_PLAYS } from "@gamefeed/domain";

export function pocMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.POC_MODE === "1";
}

/** 目標点が分布のこの位置（下から 18 件目 = 上位 1 割あたり）に来るように並べる */
const TARGET_RANK = 18;

/**
 * 仮の分布。作者の宣言した目標点（`gf:target`。「上手い人がこれくらい」）から 20 件を作る。
 * 0 点近くから目標の 1.1 倍までを等間隔に並べる（昇順）。実プレイが入れば少しずつ置き換わる。
 */
export function pocDistribution(target: number): number[] {
  return Array.from({ length: CALIBRATION_MIN_PLAYS }, (_, i) =>
    Math.max(0, Math.round((target * (i + 1)) / TARGET_RANK)),
  );
}
