// ランの進行の計算（run#A.2、A.3、A.7、A.8、sc#A.9）。サーバの next / finish が使う。I/O を持たない。
// Host 側のスロット制御（run#A.4〜A.6）は別のモジュール。

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

export type NextTurn =
  | { done: true }
  | { done: false; turn: number; index: number; lap: number; speed: Speed };

/**
 * 次に発行する手番（run#A.3）。
 * issued は発行済みの手番数、misses はここまでに確定したミスの数（summarizeRun の misses）。
 * 上限か残機切れなら done。
 */
export function nextTurn(
  mode: RunMode,
  deckLength: number,
  issued: number,
  misses: number,
): NextTurn {
  if (!(deckLength >= 1)) throw new RangeError("deck is empty");
  if (issued >= turnLimit(mode)) return { done: true };
  if (mode === "endless" && misses >= ENDLESS_LIVES) return { done: true };
  const lap = Math.floor(issued / deckLength);
  return {
    done: false,
    turn: issued,
    index: issued % deckLength,
    lap,
    speed: turnSpeed(mode, lap),
  };
}

/** 発行済みの手番 1 つ（sessions の 1 行）。配列の添字が手番番号 */
export interface RecordedTurn {
  /** open は finish の時点で abandoned として扱う（run#A.7） */
  state: "open" | "submitted" | "skipped" | "abandoned";
  via: "guest" | "timeout" | "error" | null;
  score: number | null;
  /** 発行時に凍結した閾値（sc#A.6）。新作枠・校正中・デイリーは null */
  missBelow: number | null;
  /** 受理時に計算した偏差値（sc#A.5）。校正中は null */
  deviation: number | null;
}

/**
 * 成績表での手番の扱い。
 * ok: 成立。miss: ミス。skip: 分母に入れない（「—」）。dropped: 記録から捨てた
 */
export type TurnKind = "ok" | "miss" | "skip" | "dropped";

export interface RunSummary {
  /** 到達手番数（skip を含む。sc#A.9） */
  reached: number;
  misses: number;
  /** 偏差値のある手番の平均。小数 1 桁。なければ null */
  avgDeviation: number | null;
  /** デイリーの記号列。エンドレスは null */
  symbols: string | null;
  /** lives: 残機切れ。limit: 上限まで。abandoned: 途中で終えた（中断） */
  ended: "lives" | "limit" | "abandoned";
  /** 手番ごとの扱いと、成績表に出す偏差値（skip・捨てた手番は null） */
  turns: { kind: TurnKind; deviation: number | null }[];
}

function classify(mode: RunMode, t: RecordedTurn): Exclude<TurnKind, "dropped"> {
  if (t.state === "skipped") return "skip";
  if (t.state !== "submitted") {
    // 遊んだのに結果を送らなかった手番（後ろに結果がある）。閾値があればミス（run#A.7、B.2）
    return mode === "endless" && t.missBelow !== null ? "miss" : "skip";
  }
  if (t.via !== "guest") return "skip";
  if (mode === "endless" && t.missBelow !== null && t.score !== null && t.score < t.missBelow) {
    return "miss";
  }
  return "ok";
}

function symbolOf(deviation: number | null): string {
  if (deviation === null) return SYMBOL_NONE;
  for (const [bound, symbol] of SYMBOL_BOUNDS) if (deviation >= bound) return symbol;
  return SYMBOL_BELOW;
}

/**
 * finish で凍結する値（sc#A.9）。turns は手番番号の順に、発行済みの全手番。
 *
 * - 最後に結果のある手番より後の手番（先読みの捨て）は数えない
 * - エンドレスは 3 回目のミスの手番までを数え、それ以降は捨てる
 */
export function summarizeRun(mode: RunMode, turns: readonly RecordedTurn[]): RunSummary {
  let last = -1;
  turns.forEach((t, i) => {
    if (t.state === "submitted" || t.state === "skipped") last = i;
  });

  const out: RunSummary["turns"] = [];
  let reached = 0;
  let misses = 0;
  let over = false;
  turns.forEach((t, i) => {
    if (over || i > last) {
      out.push({ kind: "dropped", deviation: null });
      return;
    }
    const kind = classify(mode, t);
    out.push({ kind, deviation: kind === "skip" ? null : t.deviation });
    reached = i + 1;
    if (kind === "miss" && ++misses >= ENDLESS_LIVES) over = true;
  });

  const counted = out.slice(0, reached);
  const devs = counted.flatMap((t) => (t.deviation === null ? [] : [t.deviation]));
  const avgDeviation =
    devs.length === 0
      ? null
      : Math.round((devs.reduce((a, b) => a + b, 0) / devs.length) * 10) / 10;

  return {
    reached,
    misses,
    avgDeviation,
    symbols: mode === "daily" ? counted.map((t) => symbolOf(t.deviation)).join("") : null,
    ended: over ? "lives" : reached >= turnLimit(mode) ? "limit" : "abandoned",
    turns: out,
  };
}
