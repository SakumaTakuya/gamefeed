// ランの計画と記録の計算（run#A.3、A.6〜A.8、sc#A.9。#151）。I/O を持たない。
//
// 手番の位置・周回・速度・seed は、計画とそれより前の手番の扱いから決まる。Host は自分が遊んだ手番から、
// サーバは記録から、同じ関数で求める。記録は Host が遊んだ列の先頭部分なので（run#A.15 F10）同じ値になる。
// 成績表は記録そのもので、サーバは Host の進行を推測しない。

import {
  ENDLESS_LIVES,
  type RunMode,
  SYMBOL_BELOW,
  SYMBOL_BOUNDS,
  SYMBOL_NONE,
  turnLimit,
  turnSpeed,
} from "./run-record.ts";
import type { Speed } from "./session.ts";
import type { TurnVia } from "./turn-result.ts";

/** 1 つのランで、読み込みの skip がこの本数になったら通信エラーで終わる（run#A.6。暫定） */
export const LOAD_SKIP_LIMIT = 3;
/** ランの期限。作成からこの時間が過ぎたランは閉じている（run#A.3、sc#A.2。暫定） */
export const RUN_EXPIRY_MS = 60 * 60 * 1000;

/**
 * 手番の扱い。
 * ok: 成立。miss: ミス。skip: 満了・`error`。noload: 読み込みの skip。
 * skip と noload は成績の分母に入れず、その位置は以後の周回に出さない（run#A.6）。
 * noload だけが通信エラーの本数に数えられる
 */
export type TurnOutcome = "ok" | "miss" | "skip" | "noload";

export type TurnAt =
  | { done: true; reason: "limit" | "no_position" }
  | { done: false; turn: number; index: number; lap: number; speed: Speed };

/**
 * 次の手番（手番番号は `earlier.length`）の山札の位置・周回・速度（run#A.3 の表）。
 * earlier はそれより前の手番の扱いで、添字が手番番号。
 *
 * 手番 0 は位置 0、周回 0。以後、手番ごとに山札の次の位置へ進み、末尾を越えて先頭に戻るたびに
 * 周回が 1 増える。デイリーは 1 周で、末尾を越えたら done（run#A.2）。skip（満了・`error`・読み込みの skip）になった位置は、それ以後飛ばす（run#A.6）。
 * 上限の手番より先と、出せる位置が無くなったときは done（次の手番が無い）。
 */
export function turnAt(mode: RunMode, deckLength: number, earlier: readonly TurnOutcome[]): TurnAt {
  if (!(Number.isInteger(deckLength) && deckLength >= 1)) throw new RangeError("deck is empty");
  const skipped = new Set<number>();
  let index = -1;
  let lap = 0;
  // 手番 0 から順にたどる。t は求める手番、earlier[t - 1] までが済んでいる
  for (let t = 0; t <= earlier.length; t++) {
    if (t >= turnLimit(mode)) return { done: true, reason: "limit" };
    const last = t > 0 ? earlier[t - 1] : undefined;
    if (last === "skip" || last === "noload") skipped.add(index);
    if (skipped.size >= deckLength) return { done: true, reason: "no_position" };
    do {
      index++;
      if (index === deckLength) {
        // デイリーは 1 周（run#A.2）。出せないお題があって山札が上限より短くても、末尾の次は無い（#182）
        if (mode === "daily") return { done: true, reason: "limit" };
        index = 0;
        lap++;
      }
    } while (skipped.has(index));
  }
  return { done: false, turn: earlier.length, index, lap, speed: turnSpeed(mode, lap) };
}

/**
 * 手番の seed（run#A.3。暫定）。ランの seed `S` と手番番号 `t` から、
 * `x = (S + t × 0x9E3779B9) mod 2³²` を mulberry32 の混合 1 回に通した 32 bit 符号なし整数。
 * 式を変えると過去のリプレイが崩れる。
 */
export function turnSeed(runSeed: number, turn: number): number {
  const a = (((runSeed + Math.imul(turn, 0x9e3779b9)) >>> 0) + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), a | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/**
 * 手番の結果から扱いを決める（run#A.6、A.7）。Host とサーバが同じ式を使う。
 * missBelow は計画に凍結した閾値。null（新作枠、校正中、デイリー）ならミスにならない
 */
export function outcomeOf(
  r: { via: "guest"; score: number } | { via: Exclude<TurnVia, "guest"> },
  missBelow: number | null,
): TurnOutcome {
  if (r.via === "noload") return "noload";
  if (r.via !== "guest") return "skip";
  return missBelow !== null && r.score < missBelow ? "miss" : "ok";
}

/**
 * 記録から決まる終わり方。lives: 残機切れ。error: 通信エラー（読み込みの skip が規定の本数）。
 * limit: 次の手番が無い（上限に達した、または山札の出せる位置が無くなった）
 */
export type LogEnd = "lives" | "error" | "limit";

export interface LogState {
  /** 記録だけからランが閉じていれば、その理由。開いていれば null（run#A.3） */
  ended: LogEnd | null;
  misses: number;
  loadSkips: number;
}

/**
 * 記録（手番の扱いの列）からランの状態を決める（run#A.3 の閉じる条件のうち、記録で決まるもの）。
 * `finish` と期限で閉じたかどうかは呼び出し側が持つ。
 */
export function logState(mode: RunMode, deckLength: number, log: readonly TurnOutcome[]): LogState {
  let misses = 0;
  let loadSkips = 0;
  for (const outcome of log) {
    if (outcome === "miss") misses++;
    if (outcome === "noload") loadSkips++;
  }
  let ended: LogEnd | null = null;
  if (mode === "endless" && misses >= ENDLESS_LIVES) ended = "lives";
  else if (loadSkips >= LOAD_SKIP_LIMIT) ended = "error";
  else if (turnAt(mode, deckLength, log).done) ended = "limit";
  return { ended, misses, loadSkips };
}

/** 記録の 1 手番。deviation は受理時の偏差値（校正中・skip は null） */
export interface LoggedTurn {
  outcome: TurnOutcome;
  deviation: number | null;
}

export interface LogSummary {
  /** 到達手番数 = 記録の長さ（skip を含む。sc#A.9） */
  reached: number;
  misses: number;
  /** 偏差値のある手番の平均。小数 1 桁。なければ null */
  avgDeviation: number | null;
  /** デイリーの記号列。1 手番 1 文字。エンドレスは null */
  symbols: string | null;
  /** abandoned: 記録からは閉じていない（中断、期限、通信が届かなかった） */
  ended: LogEnd | "abandoned";
}

function symbolOf(deviation: number | null): string {
  if (deviation === null) return SYMBOL_NONE;
  for (const [bound, symbol] of SYMBOL_BOUNDS) if (deviation >= bound) return symbol;
  return SYMBOL_BELOW;
}

/** ランが閉じたときに凍結する値（sc#A.9）。log は記録の全手番を手番の順に */
export function summarizeLog(
  mode: RunMode,
  deckLength: number,
  log: readonly LoggedTurn[],
): LogSummary {
  const state = logState(
    mode,
    deckLength,
    log.map((t) => t.outcome),
  );
  const shown = log.map((t) =>
    t.outcome === "skip" || t.outcome === "noload" ? null : t.deviation,
  );
  const devs = shown.flatMap((d) => (d === null ? [] : [d]));
  // 偏差値は小数 1 桁なので、0.1 単位の整数で足してから丸める
  const tenths = devs.reduce((a, b) => a + Math.round(b * 10), 0);
  return {
    reached: log.length,
    misses: state.misses,
    avgDeviation: devs.length === 0 ? null : Math.round(tenths / devs.length) / 10,
    symbols: mode === "daily" ? shown.map(symbolOf).join("") : null,
    ended: state.ended ?? "abandoned",
  };
}
