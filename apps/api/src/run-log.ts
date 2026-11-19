/**
 * ランの記録（run.md A.3、scoring.md A.9）。`PUT /runs/{id}/turns/{t}` と `finish` が共有する読み書き。
 *
 * 記録は `sessions(run_id, turn)` の行で、手番の順に 0 から抜けなく並ぶ（I7）。ランの進行（手番の扱い、
 * 閉じたか、成績表の値）は `@gamefeed/domain` の `outcomeOf` / `logState` / `summarizeLog` が記録から決め、
 * ここは DB から読んで渡し、決まった値を `runs` に凍結するだけ。
 * - 同じランへの書き込みは `runs` の行ロックで直列にする（I7、I13）
 * - 期限（作成から 60 分）は読むとき・書くときに見て、過ぎていればその場で閉じる。閉じるためのジョブは持たない（run#A.3）
 */

import {
  type LoggedTurn,
  type LogSummary,
  outcomeOf,
  RUN_EXPIRY_MS,
  summarizeLog,
  type TurnOutcome,
  type TurnVia,
} from "@gamefeed/domain";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { runs } from "./db/schema.ts";

export type RunRow = typeof runs.$inferSelect;

/** 記録の 1 手番（`sessions` の 1 行と、その内容の `meta.target`） */
export interface LogRow extends Record<string, unknown> {
  id: string;
  turn: number;
  post_id: string;
  via: TurnVia;
  /** `via = guest` のときだけ非 NULL */
  score: number | null;
  frames: number | null;
  speed: string;
  miss_below: number | null;
  deviation: string | null;
  is_new: boolean;
  target: number;
}

/** 記録の手番の扱い（run#A.6、A.7）。受理のときと同じ式・同じ凍結値なので、同じ値になる */
export function outcomeOfRow(row: LogRow): TurnOutcome {
  return row.via === "guest"
    ? outcomeOf({ via: "guest", score: row.score ?? 0 }, row.miss_below)
    : outcomeOf({ via: row.via }, null);
}

export const deviationOfRow = (row: LogRow): number | null =>
  row.deviation === null ? null : Number(row.deviation);

const logged = (row: LogRow): LoggedTurn => ({
  outcome: outcomeOfRow(row),
  deviation: deviationOfRow(row),
});

/** ランの記録を手番の順に読む */
export async function readLog(tx: Db, runId: string): Promise<LogRow[]> {
  const rows = await tx.execute<LogRow>(sql`
    select s.id, s.turn, s.post_id, s.via, s.score, s.frames, s.speed, s.miss_below, s.deviation, s.is_new,
           (g.meta->>'target')::int as target
    from sessions s join games g on g.hash = s.game_hash
    where s.run_id = ${runId}
    order by s.turn`);
  return [...rows];
}

/**
 * ランを閉じて、成績表の値を記録から凍結する（sc#A.9）。log は足し終えた記録の全手番。
 * `settled` も同じ文で入れる（閉じた後は変えられない。I13）。
 */
export async function freezeRun(
  tx: Db,
  run: RunRow,
  log: readonly LogRow[],
  endedAt: Date,
): Promise<RunRow> {
  const summary: LogSummary = summarizeLog(run.mode, run.deck.length, log.map(logged));
  const frozen = {
    settled: log.length,
    reached: summary.reached,
    avgDeviation: summary.avgDeviation === null ? null : summary.avgDeviation.toFixed(1),
    symbols: summary.symbols,
    ended: summary.ended,
    endedAt,
  };
  await tx.update(runs).set(frozen).where(eq(runs.id, run.id));
  return { ...run, ...frozen };
}

/**
 * ランの行をロックして、記録と一緒に返す。ランが無いか、その主体のものでなければ null（区別しない）。
 * 開いたままで期限を過ぎていれば、ここで閉じる。閉じた時刻は作成 + 60 分（dm#A.3 `ended_at`）。
 * トランザクションの中で呼ぶ。
 */
export async function openRun(
  tx: Db,
  input: { runId: string; actorId: string },
  now: Date,
): Promise<{ run: RunRow; log: LogRow[] } | null> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.actorId, input.actorId)))
    .for("update");
  if (!run) return null;
  const log = await readLog(tx, run.id);
  const deadline = run.startedAt.getTime() + RUN_EXPIRY_MS;
  if (run.endedAt === null && now.getTime() > deadline) {
    return { run: await freezeRun(tx, run, log, new Date(deadline)), log };
  }
  return { run, log };
}
