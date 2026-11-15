/**
 * ランを閉じる（run.md A.3、A.7）。`POST /api/runs/{id}/finish` の本体。
 *
 * 到達本数・平均偏差値・記号列は `@gamefeed/domain` の `summarizeRun` が決め（sc#A.9）、ここは `sessions` を
 * 手番順に渡して `runs` に凍結する。以後、分布が動いても値は変わらない（I13）。
 * - `runs` の行ロックで `next` と、`sessions` の行ロックで受理の途中の `result` と直列にする。閉じた後の `next` は `{done: true}`
 * - 結果のない手番（`open`）は `abandoned` にする。以後その手番の `result` は 409
 * - 2 回目以降は、凍結した値から同じ成績表を返す
 * 応答の形・2 回目の扱い・エラーは文書に無く、#147 の案で実装している。
 */

import { type RecordedTurn, type RunMode, ratioOf, summarizeRun } from "@gamefeed/domain";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";

export interface FinishDeps {
  db: Db;
  now: () => Date;
}

/** 成績表の 1 手番（run#A.11 の科目欄）。記録から捨てた手番は載らない */
export interface ReportTurn {
  turn: number;
  post_id: string;
  /** ok: 成立。miss: ミス。skip: 成績に入らない（「—」） */
  kind: "ok" | "miss" | "skip";
  /** 受理時の偏差値。校正中・新作扱い・skip・結果のない手番は null */
  deviation: number | null;
  /** 偏差値のない成立した手番の `min(1, score / target)`（校正中の表示）。それ以外は null */
  ratio: number | null;
  is_new: boolean;
  speed: number;
}

/** 凍結した成績表（sc#A.9、run#A.11）。Host はこれを描くだけで、計算しない */
export interface RunReport {
  run_id: string;
  mode: RunMode;
  /** lives: 残機切れ。limit: 上限まで。abandoned: 途中で終えた */
  ended: "lives" | "limit" | "abandoned";
  /** 到達手番数（skip を含む） */
  reached: number;
  avg_deviation: number | null;
  /** デイリーの記号列。エンドレスは null */
  symbols: string | null;
  turns: ReportTurn[];
}

export type FinishResult = { ok: true; value: RunReport } | { ok: false; error: "run_not_found" };

interface RunRow extends Record<string, unknown> {
  mode: RunMode;
  deck: string[];
  cursor: number;
  reached: number | null;
  avg_deviation: string | null;
  symbols: string | null;
  ended: RunReport["ended"] | null;
  ended_at: Date | string | null;
}

interface TurnRow extends Record<string, unknown> {
  turn: number;
  post_id: string;
  state: RecordedTurn["state"];
  via: RecordedTurn["via"];
  score: number | null;
  miss_below: number | null;
  deviation: string | null;
  is_new: boolean;
  speed: string;
  target: number;
}

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

    // next と同じ行ロック。数えている間に手番が増えない。同時の finish も直列になる
    const [run] = await tx.execute<RunRow>(sql`
      select mode, deck, cursor, reached, avg_deviation, symbols, ended, ended_at
      from runs where id = ${input.runId} and actor_id = ${input.actorId}
      for update`);
    if (!run) return { ok: false, error: "run_not_found" };

    // 手番の行もロックする。受理の途中の result（セッションの行ロックを持っている）は確定を待ってから数え、
    // これより後の result は abandoned を見て 409 になる。待たないと、受理された結果が成績表から漏れる
    const rows = await tx.execute<TurnRow>(sql`
      select s.turn, s.post_id, s.state, s.via, s.score, s.miss_below, s.deviation, s.is_new, s.speed,
             (g.meta->>'target')::int as target
      from sessions s join games g on g.hash = s.game_hash
      where s.run_id = ${input.runId} order by s.turn
      for update of s`);
    const summary = summarizeRun(
      run.mode,
      rows.map((t) => ({
        state: t.state,
        via: t.via,
        score: t.score,
        missBelow: t.miss_below,
        deviation: t.deviation === null ? null : Number(t.deviation),
        deckIndex: run.deck.indexOf(t.post_id),
      })),
      run.cursor,
    );

    // 手番ごとの値は sessions に凍結されている（受理時の偏差値と miss_below）。閉じた後は sessions も
    // 変わらない（open は残らない）ので、2 回目以降も同じ並びになる
    const turns: ReportTurn[] = [];
    summary.turns.forEach((t, i) => {
      const row = rows[i];
      if (!row || t.kind === "dropped") return;
      const played = t.kind !== "skip" && t.deviation === null && row.score !== null;
      turns.push({
        turn: row.turn,
        post_id: row.post_id,
        kind: t.kind,
        deviation: t.deviation,
        ratio: played ? ratioOf(row.score as number, row.target) : null,
        is_new: row.is_new,
        speed: Number(row.speed),
      });
    });

    const frozen = (
      ended: RunReport["ended"],
      reached: number,
      avg: number | null,
      symbols: string | null,
    ): FinishResult => ({
      ok: true,
      value: {
        run_id: input.runId,
        mode: run.mode,
        ended,
        reached,
        avg_deviation: avg,
        symbols,
        turns,
      },
    });

    if (run.ended_at !== null && run.ended !== null) {
      // 凍結済み。見出しの値は runs に保存したものを返す（I13）
      const avg = run.avg_deviation === null ? null : Number(run.avg_deviation);
      return frozen(run.ended, run.reached ?? 0, avg, run.symbols);
    }

    const now = deps.now().toISOString();
    // 結果のない手番は abandoned（run#A.7）。以後の result は「open でない」ので 409
    await tx.execute(
      sql`update sessions set state = 'abandoned' where run_id = ${input.runId} and state = 'open'`,
    );
    await tx.execute(sql`
      update runs
      set reached = ${summary.reached},
          avg_deviation = ${summary.avgDeviation === null ? null : summary.avgDeviation.toFixed(1)},
          symbols = ${summary.symbols}, ended = ${summary.ended}::run_end, ended_at = ${now}::timestamptz
      where id = ${input.runId}`);
    return frozen(summary.ended, summary.reached, summary.avgDeviation, summary.symbols);
  });
}
