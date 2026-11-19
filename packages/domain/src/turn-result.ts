// 手番の結果（sc#A.1、A.2、A.4、A.7。#162）。I/O を持たない。
//
// 結果は 4 種類の直和: 遊んだ結果（guest）・満了（timeout）・error・読み込みの skip（noload）。
// 値を持つのは遊んだ結果だけ。遊んだ結果の述語は Host とサーバが同じ関数で確かめ、Host は満たさない
// Guest の報告を値を直さずに捨てる。だから Host が送る結果は必ずサーバで受理される。

import { CALIBRATION_MIN_PLAYS } from "./deviation.ts";
import {
  DISTRIBUTION_MIN_FRAMES_RATIO,
  REALTIME_FACTOR,
  REALTIME_SLACK_SEC,
  SCORE_MAX,
  ZERO_STUCK_RATIO,
} from "./result.ts";

/** 実時間の検査で、遊んだ結果 1 件ごとに許す余裕（秒。sc#A.2、暫定） */
export const REALTIME_SLACK_PER_TURN_SEC = 0.1;
/** 失敗率がこれ以上なら invalid（sc#A.7、暫定） */
export const FAILURE_RATE_INVALID = 0.5;

/** 結果の種類（sc#A.1）。noload はセッションが始まらなかった読み込みの skip */
export type TurnVia = "guest" | "timeout" | "error" | "noload";

/** 本文から読んだ結果。遊んだ結果の値はまだ確かめていない */
export type TurnResultBody =
  | { via: "guest"; score: unknown; frames: unknown; inputs: unknown }
  | { via: "timeout" }
  | { via: "error" }
  | { via: "noload" };

const sameKeys = (o: object, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

/**
 * 本文を 4 つの形のどれかとして読む（sc#A.2）。どの形でもなければ null（API は 400）。
 * 余分なキーも、足りないキーも形の違い。値の中身は見ない（`checkPlayed` が見る）。
 */
export function readTurnResult(body: unknown): TurnResultBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.via === "guest") {
    if (!sameKeys(b, ["via", "score", "frames", "inputs"])) return null;
    return { via: "guest", score: b.score, frames: b.frames, inputs: b.inputs };
  }
  if (b.via === "timeout" || b.via === "error" || b.via === "noload") {
    return sameKeys(b, ["via"]) ? { via: b.via } : null;
  }
  return null;
}

const isIntIn = (x: unknown, min: number, max: number): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;

/** 述語のどの行に外れたか（sc#A.2 の表の 3〜6 行目） */
export type PlayedRejection = "score" | "frames" | "inputs" | "realtime";

/**
 * 遊んだ結果の述語のうち、Host とサーバで同じ式の部分（sc#A.2 の 3〜5 行目）。
 * 満たせば null、外れたら表で上にある行。`frames` は 0 を通す。
 */
export function checkPlayed(
  r: { score: unknown; frames: unknown; inputs: unknown },
  timeLimit: number,
): Exclude<PlayedRejection, "realtime"> | null {
  if (!isIntIn(r.score, 0, SCORE_MAX)) return "score";
  if (!isIntIn(r.frames, 0, timeLimit)) return "frames";
  if (!Array.isArray(r.inputs)) return "inputs";
  let prev = 0;
  for (const entry of r.inputs) {
    if (!Array.isArray(entry)) return "inputs";
    const frame: unknown = entry[0];
    if (!isIntIn(frame, prev, r.frames)) return "inputs";
    prev = frame;
  }
  return null;
}

/** 遊んだ結果が実時間で何秒ぶんか: frames ÷ (60 × speed) */
export function playedSeconds(frames: number, speed: number): number {
  return frames / (60 * speed);
}

/**
 * 実時間の検査の Host の式（sc#A.2 の 6 行目）。ranSec はその手番が走っていた秒
 * （`start` から `end` まで。`pause` の間を除く）。
 */
export function hostRealtimeOk(frames: number, speed: number, ranSec: number): boolean {
  return playedSeconds(frames, speed) <= ranSec * REALTIME_FACTOR + REALTIME_SLACK_PER_TURN_SEC;
}

/**
 * 実時間の検査のサーバの式（sc#A.2 の 6 行目）。playedSec と count は、記録にある遊んだ結果と
 * この結果を合わせた合計と件数。elapsedSec はランの作成からの経過秒。
 * Host の式を手番ごとに足すとこの式になる（手番は重ならず、ランの作成より後に走る）。
 */
export function serverRealtimeOk(a: {
  playedSec: number;
  count: number;
  elapsedSec: number;
}): boolean {
  return (
    a.playedSec <=
    a.elapsedSec * REALTIME_FACTOR + REALTIME_SLACK_PER_TURN_SEC * a.count + REALTIME_SLACK_SEC
  );
}

/**
 * 結果の行き先（sc#A.4）。distribution: 分布に `score` が入る。failure: 失敗の数に入る。
 * null: どちらにも入らない。1 主体 5 件の窓は、ほかの結果との関係なので呼び出し側が見る。
 */
export function tallyOf(
  r: { speed: number; author: boolean } & (
    | {
        via: "guest";
        verdict: "provisional" | "accepted" | "rejected" | "flagged";
        frames: number;
        timeLimit: number;
      }
    | { via: "timeout" | "error" | "noload" }
  ),
): "distribution" | "failure" | null {
  if (r.via === "noload" || r.speed !== 1 || r.author) return null;
  if (r.via !== "guest") return "failure";
  const counted = r.verdict === "provisional" || r.verdict === "accepted";
  return counted && r.frames >= DISTRIBUTION_MIN_FRAMES_RATIO * r.timeLimit ? "distribution" : null;
}

/**
 * 未校正のゲームの行き先（sc#A.7）。scores は分布の点数（順序は問わない）、failures は失敗の数。
 * 検査は n + f が 20 以上になってから。失敗率が高ければ invalid。分布の形の検査（分散ゼロ、0 張り付き）と
 * calibrated への遷移は、分布が 20 件になってから。まだ決まらなければ null。
 * 二峰・耐久型などの印と通知はここでは見ない。
 */
export function calibrationVerdict(
  scores: readonly number[],
  failures: number,
): "calibrated" | "invalid" | null {
  const n = scores.length;
  const total = n + failures;
  if (total < CALIBRATION_MIN_PLAYS) return null;
  if (failures >= FAILURE_RATE_INVALID * total) return "invalid";
  if (n < CALIBRATION_MIN_PLAYS) return null;
  if (scores.every((s) => s === scores[0])) return "invalid";
  const zeros = scores.reduce((count, s) => (s === 0 ? count + 1 : count), 0);
  if (zeros >= ZERO_STUCK_RATIO * n) return "invalid";
  return "calibrated";
}
