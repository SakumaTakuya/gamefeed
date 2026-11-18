/**
 * ランの作成（run.md A.2、A.3）。`POST /api/runs` の本体。
 *
 * 計画（山札、位置ごとの `is_new`・`miss_below`・内容、ランの seed）を凍結して `runs` に 1 行入れる。
 * 手番（`sessions`）はここでは作らない。
 * 山札の組み方は `@gamefeed/domain` の `buildEndlessDeck`、閾値は `missBelow`。ここは DB から集めて写すだけ。
 * エラーの形と「引いた」の定義は文書に無く、#161 の A・B の案で実装している。`from_run` は run#A.3（#175）。
 */

import {
  buildEndlessDeck,
  CALIBRATION_MIN_PLAYS,
  DECK_RECENT_DAYS,
  type Deck,
  type DeckCandidate,
  ENDLESS_LIVES,
  missBelow,
  type RunMode,
} from "@gamefeed/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { runs } from "./db/schema.ts";
import { ulid } from "./id.ts";

export interface RunDeps {
  db: Db;
  now: () => Date;
  /** [0, 1) の乱数。山札の抽選と並び、新作枠の位置（run#A.10）、ランの seed（run#A.3）に使う */
  random: () => number;
}

export interface CreateRunInput {
  mode: "endless";
  /** 共有リンク `/r/<run_id>` からの再現（run#A.14） */
  fromRun?: string;
}

/** 計画の、山札の 1 つの位置（run#A.3） */
export interface PlannedTurn {
  post_id: string;
  /** 新作扱いの位置 */
  is_new: boolean;
  /** 何点未満ならミスか（sc#A.6）。閾値を持たない位置は null */
  miss_below: number | null;
  /** 内容の `meta.duration_frames`。Host は `init.time_limit` にこの値を入れる */
  time_limit: number;
}

export interface CreatedRun {
  run_id: string;
  /** ランの seed（32 bit 符号なし）。手番の seed は `turnSeed(seed, t)` */
  seed: number;
  /** 山札の順 */
  deck: PlannedTurn[];
}

export type RunError = "invalid_request" | "run_not_found" | "no_games";
export type CreateRunResult = { ok: true; value: CreatedRun } | { ok: false; error: RunError };

/**
 * `POST /runs` の本文 `{mode, theme?, from_run?}`（run#A.3）を読む。形式外は null（400 `invalid_request`）。
 * `mode: daily` と `theme` は W4（デイリー）で受ける。それまでは `endless` だけ。
 */
export function parseCreateRunInput(body: unknown): CreateRunInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { mode, from_run: fromRun } = body as Record<string, unknown>;
  if (mode !== "endless") return null;
  if (fromRun === undefined || fromRun === null) return { mode };
  if (typeof fromRun !== "string" || fromRun.length === 0 || fromRun.length > 64) return null;
  return { mode, fromRun };
}

/**
 * ランに出せるゲーム（`post_eligibility`。sc#A.8）と、その主体が直近 DECK_RECENT_DAYS 日に引いた日時。
 * 「引いた」はその主体のランの山札に入ったこと。日時は `runs.started_at` の新しい方（#141）。
 */
async function deckCandidates(deps: RunDeps, actorId: string): Promise<DeckCandidate[]> {
  const since = new Date(deps.now().getTime() - DECK_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await deps.db.execute<{
    id: string;
    eligibility: "normal" | "new";
    drawn_at: number | null;
  }>(sql`
    select e.id, e.eligibility, d.drawn_at
    from post_eligibility e
    left join (
      select p.post_id, (extract(epoch from max(r.started_at)) * 1000)::float8 as drawn_at
      from runs r cross join lateral unnest(r.deck) as p(post_id)
      where r.actor_id = ${actorId} and r.started_at > ${since.toISOString()}::timestamptz
      group by p.post_id
    ) d on d.post_id = e.id
    where e.eligibility in ('normal', 'new')`);
  return rows.map((r) => ({ postId: r.id, kind: r.eligibility, drawnAt: r.drawn_at }));
}

/**
 * `from_run` の山札を写す（run#A.3）。作成時点でランに出せない投稿は落とし、残りの順と新作扱いの位置は保つ。
 * 基準は新規のランと同じ `post_eligibility`（sc#A.8）。計画にはランに出せる投稿だけが入る（run#A.2、#175）。
 * 元のランが無ければ null、全部落ちたら山札が空の Deck を返す。
 */
async function copyDeck(db: Db, fromRun: string): Promise<Deck | null> {
  const [src] = await db
    .select({ deck: runs.deck, newIndexes: runs.newIndexes })
    .from(runs)
    .where(and(eq(runs.id, fromRun), eq(runs.mode, "endless")));
  if (!src) return null;
  if (src.deck.length === 0) return { deck: [], newIndexes: [] };
  const rows = await db.execute<{ id: string }>(sql`
    select id from post_eligibility
    where id in (${sql.join(
      src.deck.map((id) => sql`${id}`),
      sql`, `,
    )}) and eligibility in ('normal', 'new')`);
  const servable = new Set(rows.map((r) => r.id));
  const wasNew = new Set(src.newIndexes);
  const deck: string[] = [];
  const newIndexes: number[] = [];
  src.deck.forEach((postId, i) => {
    if (!servable.has(postId)) return;
    if (wasNew.has(i)) newIndexes.push(deck.length);
    deck.push(postId);
  });
  return { deck, newIndexes };
}

interface PlanRow extends Record<string, unknown> {
  id: string;
  game_hash: string;
  calibration: string;
  time_limit: number;
  scores: number[] | null;
}

/**
 * 作成時点の分布から `miss_below` を求める（sc#A.6）。値を持つのはエンドレスの、新作扱いでない、
 * 校正済みの位置だけ。分布が校正に要る件数に満たなければ偏差値を出せない（sc#A.5）ので null。
 */
function planMissBelow(mode: RunMode, isNew: boolean, post: PlanRow): number | null {
  if (mode !== "endless" || isNew || post.calibration !== "calibrated") return null;
  const scores = post.scores ?? [];
  if (scores.length < CALIBRATION_MIN_PLAYS) return null;
  // post_stats.scores は昇順（dm#A.3）。並びが崩れていても閾値がずれないよう、ここで並べ直す
  return missBelow([...scores].sort((a, b) => a - b));
}

/**
 * 山札の位置ごとの計画の値（内容、`time_limit`、`miss_below`）を集める（run#A.3）。
 * 山札を決めた読みとは別の文なので、その間に投稿の状態や分布が動くことはある。動いた結果は
 * 「作成の直後に動いた」のと同じ扱いになる（出せなくなった投稿は読み込みの skip。公開後の内容は変わらない。I10）。
 */
async function planFor(
  db: Db,
  mode: RunMode,
  built: Deck,
): Promise<{ gameHashes: string[]; turns: PlannedTurn[] }> {
  const rows = await db.execute<PlanRow>(sql`
    select p.id, p.game_hash, p.calibration,
           (g.meta->>'duration_frames')::int as time_limit, st.scores
    from posts p
    join games g on g.hash = p.game_hash
    left join post_stats st on st.post_id = p.id
    where ${inArray(sql`p.id`, built.deck)}`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const isNew = new Set(built.newIndexes);
  const gameHashes: string[] = [];
  const turns = built.deck.map((postId, i): PlannedTurn => {
    const post = byId.get(postId);
    // 山札に入るのは公開済みの投稿で、行が消えるのは draft だけ（mo#B.6）
    if (!post) throw new Error(`山札の投稿が無い: ${postId}`);
    gameHashes.push(post.game_hash);
    return {
      post_id: postId,
      is_new: isNew.has(i),
      miss_below: planMissBelow(mode, isNew.has(i), post),
      time_limit: post.time_limit,
    };
  });
  return { gameHashes, turns };
}

/** エンドレスのランを作る。計画はこの時点で凍結し、以後変わらない（run#A.3、I13） */
export async function createRun(
  deps: RunDeps,
  actorId: string,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  let built: Deck | null;
  if (input.fromRun !== undefined) {
    built = await copyDeck(deps.db, input.fromRun);
    if (!built) return { ok: false, error: "run_not_found" };
    if (built.deck.length === 0) return { ok: false, error: "no_games" };
  } else {
    built = buildEndlessDeck(await deckCandidates(deps, actorId), deps.random);
    if (!built) return { ok: false, error: "no_games" };
  }
  const plan = await planFor(deps.db, input.mode, built);
  // ランの seed は 32 bit 符号なし（run#A.3）。`from_run` でも写さず、新しく引く
  const seed = Math.floor(deps.random() * 0x1_0000_0000) >>> 0;
  const now = deps.now();
  const id = ulid(now.getTime());
  await deps.db.insert(runs).values({
    id,
    mode: input.mode,
    actorId,
    deck: built.deck,
    newIndexes: built.newIndexes,
    gameHashes: plan.gameHashes,
    missBelow: plan.turns.map((t) => t.miss_below),
    seed,
    fromRun: input.fromRun ?? null,
    lives: ENDLESS_LIVES,
    startedAt: now,
  });
  return { ok: true, value: { run_id: id, seed, deck: plan.turns } };
}
