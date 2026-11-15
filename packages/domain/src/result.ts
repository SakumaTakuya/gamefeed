// 結果の受理条件・分布に入る条件・校正の検査（sc#A.2、A.4、A.7）。`PUT /sessions/{id}/result` が使う。
// I/O を持たない。分布の更新（1 主体 5 件の窓を含む）と状態の保存は API 側のトランザクション。

import { CALIBRATION_MIN_PLAYS } from "./deviation.ts";

/** 結果を受け付ける期限。発行からの時間（sc#A.2。暫定） */
export const RESULT_EXPIRY_MS = 30 * 60 * 1000;
/** score の上限（gc#A.4、sc#A.2） */
export const SCORE_MAX = 2 ** 31 - 1;
/** 実時間の検査: frames ÷ (60 × speed) ≤ 経過秒 × REALTIME_FACTOR ＋ REALTIME_SLACK_SEC（sc#A.2） */
export const REALTIME_FACTOR = 1.05;
export const REALTIME_SLACK_SEC = 3;
/** 分布に入れる frames の下限（time_limit に対する割合。sc#A.4、暫定） */
export const DISTRIBUTION_MIN_FRAMES_RATIO = 0.9;
/** 1 主体 1 ゲームにつき分布に入る直近の件数（sc#A.4、暫定） */
export const DISTRIBUTION_WINDOW = 5;
/** 0 張り付きで invalid にする 0 の割合（sc#A.7、暫定） */
export const ZERO_STUCK_RATIO = 0.8;

export type ResultVia = "guest" | "timeout" | "error";

/** 発行時にセッションへ凍結した値のうち、受理の検査に使うもの */
export interface IssuedSession {
  timeLimit: number;
  speed: number;
  /** 発行時刻（エポックミリ秒） */
  issuedAtMs: number;
}

/** 拒否の理由。sc#A.2 の表の行に対応する（`open` でないことは DB を見る側が判定する） */
export type ResultRejection = "expired" | "score" | "frames" | "inputs" | "realtime" | "via";

export type ResultCheck =
  | { ok: true; kind: "skipped" }
  | {
      ok: true;
      kind: "result";
      score: number;
      frames: number;
      via: ResultVia;
      /** 入力ログ。各要素の先頭がフレーム番号（protocol#A.3） */
      inputs: unknown[][];
    }
  | { ok: false; reason: ResultRejection; flagged: boolean };

const reject = (reason: ResultRejection, flagged = false): ResultCheck => ({
  ok: false,
  reason,
  flagged,
});

const isIntIn = (x: unknown, min: number, max: number): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;

/** 入力ログの frame が単調非減少で、最大値が frames 以下か（sc#A.2）。形が読めないものも通さない */
function inputsOk(inputs: unknown, frames: number): inputs is unknown[][] {
  if (!Array.isArray(inputs)) return false;
  let prev = 0;
  for (const entry of inputs) {
    if (!Array.isArray(entry)) return false;
    const frame: unknown = entry[0];
    if (!isIntIn(frame, prev, frames)) return false;
    prev = frame;
  }
  return true;
}

/**
 * `result` の本文を sc#A.2 の条件で検査する。セッションが `open` であること（1 行目）は呼び出し側が見る。
 * 複数の条件に外れたら、表の上にある条件を理由にする。
 * 本文が `{skipped: true}` だけなら読み込みの skip で、期限だけを見る（run#A.6）。
 */
export function checkResult(session: IssuedSession, body: unknown, nowMs: number): ResultCheck {
  const elapsedMs = nowMs - session.issuedAtMs;
  if (elapsedMs > RESULT_EXPIRY_MS) return reject("expired");
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.skipped === true && Object.keys(b).length === 1) return { ok: true, kind: "skipped" };

  const { score, frames, inputs, via } = b;
  if (!isIntIn(score, 0, SCORE_MAX)) return reject("score");
  if (!isIntIn(frames, 1, session.timeLimit)) return reject("frames");
  if (!inputsOk(inputs, frames)) return reject("inputs", true);
  // 実時間より多くのフレームを申告していないか
  const playedSec = frames / (60 * session.speed);
  if (playedSec > (elapsedMs / 1000) * REALTIME_FACTOR + REALTIME_SLACK_SEC) {
    return reject("realtime", true);
  }
  if (via !== "guest" && via !== "timeout" && via !== "error") return reject("via");
  if (via !== "guest" && score !== 0) return reject("via");
  return { ok: true, kind: "result", score, frames, via, inputs };
}

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

/**
 * その結果が分布に入るか（sc#A.4）。via は問わない。
 * 1 主体 5 件の窓は、ほかの結果との関係なので呼び出し側が見る。
 */
export function entersDistribution(r: {
  verdict: "provisional" | "accepted" | "rejected" | "flagged";
  speed: number;
  author: boolean;
  frames: number;
  timeLimit: number;
}): boolean {
  return (
    (r.verdict === "provisional" || r.verdict === "accepted") &&
    r.speed === 1 &&
    !r.author &&
    r.frames >= DISTRIBUTION_MIN_FRAMES_RATIO * r.timeLimit
  );
}

/**
 * 未校正のゲームの行き先（sc#A.7）。scores は分布の点数（順序は問わない）。
 * n が校正に要る件数に満たなければ null（まだ決まらない）。分散ゼロと 0 張り付きは invalid。
 * 二峰・耐久型などの印と通知はここでは見ない。
 */
export function calibrationCheck(scores: readonly number[]): "calibrated" | "invalid" | null {
  const n = scores.length;
  if (n < CALIBRATION_MIN_PLAYS) return null;
  if (scores.every((s) => s === scores[0])) return "invalid";
  const zeros = scores.reduce((count, s) => (s === 0 ? count + 1 : count), 0);
  if (zeros >= ZERO_STUCK_RATIO * n) return "invalid";
  return "calibrated";
}
