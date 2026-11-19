/**
 * ランを閉じる（run.md A.3、A.7）。`POST /api/runs/{id}/finish` の本体。
 *
 * 成績表は記録そのもの（`sessions(run_id, turn)` の行）で、サーバは Host の進行を推測しない。
 * 到達本数・平均偏差値・記号列・終わった理由は `@gamefeed/domain` の `summarizeLog` が記録から決め（sc#A.9）、
 * ここは `runs` に凍結する。以後、分布が動いても値は変わらない（I13）。
 * - `runs` の行ロックで、同じランへの結果の追記・ほかの `finish` と直列にする
 * - 記録で閉じたラン（3 回目のミスなど）と期限で閉じたランは、閉じたときに凍結した値を返す
 * - 何度呼んでも同じ成績表を返す
 * 誰が呼べるか、応答の形、校正中の比の出し方は文書に無く、#161 の D の案で実装している。
 */

import { type RunMode, ratioOf } from "@gamefeed/domain";
import type { Db } from "./db/client.ts";
import { deviationOfRow, freezeRun, openRun, outcomeOfRow } from "./run-log.ts";

export interface FinishDeps {
  db: Db;
  now: () => Date;
}

/** 成績表の 1 手番（run#A.11 の科目欄）。記録にある手番だけが載る */
export interface ReportTurn {
  turn: number;
  post_id: string;
  /** ok: 成立。miss: ミス。skip: 成績に入らない（「—」。満了・`error`・読み込みの skip） */
  kind: "ok" | "miss" | "skip";
  /** 受理時の偏差値。校正中・新作扱い・skip は null */
  deviation: number | null;
  /** 偏差値のない遊んだ結果の `min(1, score / target)`（校正中の表示）。それ以外は null */
  ratio: number | null;
  is_new: boolean;
  speed: number;
}

/** 凍結した成績表（sc#A.9、run#A.11）。Host はこれを描くだけで、計算しない */
export interface RunReport {
  run_id: string;
  mode: RunMode;
  /** lives: 残機切れ。limit: 次の手番が無い。error: 通信エラー。abandoned: 中断・期限・通信が届かなかった */
  ended: "lives" | "limit" | "abandoned" | "error";
  /** 到達手番数 = 記録の長さ（skip を含む） */
  reached: number;
  avg_deviation: number | null;
  /** デイリーの記号列。エンドレスは null */
  symbols: string | null;
  turns: ReportTurn[];
}

export type FinishResult = { ok: true; value: RunReport } | { ok: false; error: "run_not_found" };

/**
 * ランを閉じて成績表を返す。既に閉じたランは凍結した値をそのまま返す。
 * ランが無いか、その主体のものでなければ `run_not_found`（区別しない）。
 */
export async function finishRun(
  deps: FinishDeps,
  input: { runId: string; actorId: string },
): Promise<FinishResult> {
  return deps.db.transaction(async (txn): Promise<FinishResult> => {
    const tx = txn as unknown as Db;
    const now = deps.now();
    const opened = await openRun(tx, input, now);
    if (!opened) return { ok: false, error: "run_not_found" };
    const { log } = opened;
    // 開いていれば、ここで閉じる（run#A.3 の閉じる条件「finish が届いた」）
    const run =
      opened.run.endedAt === null ? await freezeRun(tx, opened.run, log, now) : opened.run;

    // 手番ごとの値は sessions に凍結されている（受理時の偏差値と miss_below）。閉じたランに手番は
    // 足されないので、2 回目以降も同じ並びになる。比は不変の score と meta.target から毎回計算する
    const turns = log.map((row): ReportTurn => {
      const outcome = outcomeOfRow(row);
      const skip = outcome === "skip" || outcome === "noload";
      const dev = skip ? null : deviationOfRow(row);
      return {
        turn: row.turn,
        post_id: row.post_id,
        kind: skip ? "skip" : outcome,
        deviation: dev,
        ratio: !skip && dev === null && row.score !== null ? ratioOf(row.score, row.target) : null,
        is_new: row.is_new,
        speed: Number(row.speed),
      };
    });
    return {
      ok: true,
      value: {
        run_id: run.id,
        mode: run.mode,
        ended: run.ended ?? "abandoned",
        reached: run.reached ?? log.length,
        avg_deviation: run.avgDeviation === null ? null : Number(run.avgDeviation),
        symbols: run.symbols,
        turns,
      },
    };
  });
}
