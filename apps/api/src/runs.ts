/**
 * ランの作成（run.md A.2、A.3）。`POST /api/runs` の本体。
 *
 * 山札を確定して `runs` に 1 行入れる。手番（`sessions`）は `next` が発行するので、ここでは作らない。
 * 山札の組み方は `@gamefeed/domain` の `buildEndlessDeck`、ここは候補を DB から集めるだけ。
 * 応答の形・エラー・`from_run` の扱い・「引いた」の定義は文書に無く、#141 の案で実装している。
 */

import {
  buildEndlessDeck,
  DECK_RECENT_DAYS,
  type Deck,
  type DeckCandidate,
  ENDLESS_LIVES,
} from "@gamefeed/domain";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { runs } from "./db/schema.ts";
import { ulid } from "./id.ts";

export interface RunDeps {
  db: Db;
  now: () => Date;
  /** [0, 1) の乱数。山札の抽選と並び、新作枠の位置に使う（run#A.10） */
  random: () => number;
}

export interface CreateRunInput {
  mode: "endless";
  /** 共有リンク `/r/<run_id>` からの再現（run#A.14） */
  fromRun?: string;
}

export interface CreatedRun {
  run_id: string;
  /** 山札の順。`is_new` は新作扱いの位置（run#A.3） */
  deck: { post_id: string; is_new: boolean }[];
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

/** `from_run` の山札をそのまま写す（投稿の状態は見直さない。出せなくなった投稿は next が飛ばす。mo#A.3） */
async function copyDeck(db: Db, fromRun: string): Promise<Deck | null> {
  const [src] = await db
    .select({ deck: runs.deck, newIndexes: runs.newIndexes })
    .from(runs)
    .where(and(eq(runs.id, fromRun), eq(runs.mode, "endless")));
  return src ?? null;
}

/** エンドレスのランを作る。山札はこの時点で確定し、以後変わらない（run#A.3） */
export async function createRun(
  deps: RunDeps,
  actorId: string,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  let built: Deck | null;
  if (input.fromRun !== undefined) {
    built = await copyDeck(deps.db, input.fromRun);
    if (!built) return { ok: false, error: "run_not_found" };
  } else {
    built = buildEndlessDeck(await deckCandidates(deps, actorId), deps.random);
    if (!built) return { ok: false, error: "no_games" };
  }
  const now = deps.now();
  const id = ulid(now.getTime());
  await deps.db.insert(runs).values({
    id,
    mode: input.mode,
    actorId,
    deck: built.deck,
    newIndexes: built.newIndexes,
    fromRun: input.fromRun ?? null,
    lives: ENDLESS_LIVES,
    startedAt: now,
  });
  const isNew = new Set(built.newIndexes);
  return {
    ok: true,
    value: {
      run_id: id,
      deck: built.deck.map((post_id, i) => ({ post_id, is_new: isNew.has(i) })),
    },
  };
}
