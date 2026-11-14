/**
 * 手番の発行（run.md A.3）。`POST /api/runs/{id}/next` の本体。
 *
 * ランの進行はサーバが持つ（run#B.1）。山札の位置・周回・速度は `@gamefeed/domain` の `nextTurn` が決め、
 * ここは発行済みの手番と投稿の今の状態を DB から集め、`sessions` に 1 行入れる。
 * - 出せなくなった投稿は手番を消費せずに飛ばす（mo#A.3）。飛ばした分は `runs.cursor` に残す
 * - `miss_below` は発行時点の分布（`post_stats`）から求めて `sessions` に凍結する（sc#A.6）
 * - 同じランの発行は `runs` の行ロックで直列にし、`(run_id, turn)` を重ねない（I13）
 * 応答のステータス・エラー・終わったランの扱いなどは文書に無く、#143 の案で実装している。
 */

import {
  CALIBRATION_MIN_PLAYS,
  missBelow,
  nextTurn,
  type RecordedTurn,
  type RunMode,
  summarizeRun,
} from "@gamefeed/domain";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { sessions } from "./db/schema.ts";
import { ulid } from "./id.ts";

export interface TurnDeps {
  db: Db;
  now: () => Date;
  /** [0, 1) の乱数。手番の seed に使う */
  random: () => number;
}

export type DeviceKind = "ios" | "android" | "other";

/** 発行時の User-Agent から端末の種類を決める（dm#A.3 `sessions.device_kind`。sc#A.7 の端末差に使う） */
export function deviceKindOf(userAgent: string | undefined | null): DeviceKind {
  if (!userAgent) return "other";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "other";
}

/** run#A.3 の応答。Host は `speed` をそのまま `init.speed` に渡し、`post_id` からゲーム URL を組む */
export interface IssuedTurn {
  turn: number;
  post_id: string;
  session_id: string;
  /** 32 bit 符号なし（protocol#A.3） */
  seed: number;
  speed: number;
  is_new: boolean;
  lap: number;
  /** この手番で何点未満ならミスか。新作扱い・校正中・デイリーは null（sc#A.6） */
  miss_below: number | null;
}

export type NextResult =
  | { ok: true; value: IssuedTurn | { done: true } }
  | { ok: false; error: "run_not_found" };

export interface NextInput {
  runId: string;
  actor: { id: string; userId: string | null };
  deviceKind: DeviceKind;
}

interface RunRow extends Record<string, unknown> {
  mode: RunMode;
  deck: string[];
  new_indexes: number[];
  cursor: number;
  ended_at: Date | string | null;
}

interface TurnRow extends Record<string, unknown> {
  state: RecordedTurn["state"];
  via: RecordedTurn["via"];
  score: number | null;
  miss_below: number | null;
  deviation: string | null;
}

interface PostRow extends Record<string, unknown> {
  id: string;
  eligibility: "normal" | "new" | "none";
  game_hash: string;
  user_id: string;
  calibration: string;
  time_limit: number;
  scores: number[] | null;
}

/**
 * 発行時点の分布から `miss_below` を求める（sc#A.6）。値を持つのはエンドレスの、新作扱いでない、
 * 校正済みの手番だけ（I12）。分布が校正に要る件数に満たなければ偏差値を出せない（sc#A.5）ので null。
 */
function frozenMissBelow(mode: RunMode, isNew: boolean, post: PostRow): number | null {
  if (mode !== "endless" || isNew || post.calibration !== "calibrated") return null;
  const scores = post.scores ?? [];
  if (scores.length < CALIBRATION_MIN_PLAYS) return null;
  // post_stats.scores は昇順（dm#A.3）。並びが崩れていても閾値がずれないよう、ここで並べ直す
  return missBelow([...scores].sort((a, b) => a - b));
}

/**
 * 次の手番を 1 つ発行する。上限・残機切れ・終わったラン・山札の全部が出せないときは `{done: true}`。
 * ランが無いか、その主体のものでなければ `run_not_found`（区別しない）。
 */
export async function issueNextTurn(deps: TurnDeps, input: NextInput): Promise<NextResult> {
  return deps.db.transaction(async (txn): Promise<NextResult> => {
    const tx = txn as unknown as Db;

    // 同じランの next を直列にする。発行済みの手番数を数えてから挿入するまでの間に別の発行が入らない
    const [run] = await tx.execute<RunRow>(sql`
      select mode, deck, new_indexes, cursor, ended_at
      from runs where id = ${input.runId} and actor_id = ${input.actor.id}
      for update`);
    if (!run) return { ok: false, error: "run_not_found" };
    if (run.ended_at !== null) return { ok: true, value: { done: true } };

    const issued = await tx.execute<TurnRow>(sql`
      select state, via, score, miss_below, deviation
      from sessions where run_id = ${input.runId} order by turn`);
    // ここまでに確定したミスは finish と同じ数え方（run#A.7）。結果のない手番の扱いも揃う
    const { misses } = summarizeRun(
      run.mode,
      issued.map((t) => ({
        state: t.state,
        via: t.via,
        score: t.score,
        missBelow: t.miss_below,
        deviation: t.deviation === null ? null : Number(t.deviation),
      })),
    );

    // 山札の投稿の今の状態（mo#A.3「next は発行時に post_eligibility を見直す」）
    const posts = await tx.execute<PostRow>(sql`
      select e.id, e.eligibility, p.game_hash, p.user_id, p.calibration,
             (g.meta->>'duration_frames')::int as time_limit, st.scores
      from post_eligibility e
      join posts p on p.id = e.id
      join games g on g.hash = p.game_hash
      left join post_stats st on st.post_id = e.id
      where e.id in ${run.deck}`);
    const byId = new Map(posts.map((p) => [p.id, p]));

    // 出せなくなった投稿は手番を消費せず山札の次に進む。1 周ぶん続けて出せなければ、出せる投稿が無い
    let cursor = run.cursor;
    for (let skipped = 0; skipped < run.deck.length; skipped++, cursor++) {
      const t = nextTurn(run.mode, run.deck.length, issued.length, misses, cursor);
      if (t.done) return { ok: true, value: { done: true } };
      const post = byId.get(run.deck[t.index] as string);
      if (!post || post.eligibility === "none") continue;

      const now = deps.now();
      const isNew = run.new_indexes.includes(t.index);
      const value: IssuedTurn = {
        turn: t.turn,
        post_id: post.id,
        session_id: ulid(now.getTime()),
        seed: Math.floor(deps.random() * 2 ** 32),
        speed: t.speed,
        is_new: isNew,
        lap: t.lap,
        miss_below: frozenMissBelow(run.mode, isNew, post),
      };
      await tx.insert(sessions).values({
        id: value.session_id,
        postId: post.id,
        gameHash: post.game_hash,
        actorId: input.actor.id,
        deviceKind: input.deviceKind,
        runId: input.runId,
        turn: value.turn,
        mode: "play",
        seed: value.seed,
        speed: value.speed.toFixed(3),
        timeLimit: post.time_limit,
        missBelow: value.miss_below,
        isNew,
        author: input.actor.userId !== null && input.actor.userId === post.user_id,
        issuedAt: now,
      });
      await tx.execute(sql`update runs set cursor = ${cursor + 1} where id = ${input.runId}`);
      return { ok: true, value };
    }
    return { ok: true, value: { done: true } };
  });
}
