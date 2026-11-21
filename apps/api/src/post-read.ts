/**
 * 公開済みの投稿を読む（`GET /api/posts/{id}`。ゲームページ `/g/<post_id>` が使う。run.md A.14）。
 *
 * 見えるのは投稿状態が `limited` / `public` のものだけ（moderation.md A.3 の「直リンク」、mcp.md A.9）。
 * それ以外（`draft` / `restricted` / `unpublished` / `removed`、存在しない ID）は null で、呼び出し側は
 * 理由を区別せず `not_found` を返す。作者が呼んでも同じ（作者が見るのは試遊ページと「作る」ページ）。
 */

import { CALIBRATION_MIN_PLAYS, deviation, SCORE_MAX } from "@gamefeed/domain";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { postStats, posts, users } from "./db/schema.ts";

/** ULID（dm#A.1）。形の違う ID は DB を引かずに「無い」 */
const POST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface PublicPost {
  post_id: string;
  title: string;
  /** 作者。公開するのは `handle` だけ（mc#A.5。`auth_user.name` と `email` は出さない） */
  author: { handle: string };
  published_at: string;
  /** 呼んだ端末（`X-Device-Id`）がいいね済みか。端末が分からなければ false */
  liked: boolean;
  /**
   * プレイ数（分布の件数。sc#A.4。`list_my_games` の `plays` と同じ値）といいね数。
   * 校正済みの投稿だけ（product#9 の 5）。それ以外は null
   */
  stats: { plays: number; likes: number } | null;
}

/** 投稿状態が `limited` / `public` か（dm#A.4 のビュー post_status。制限は indiv_restricted と tree_locks から） */
const visible = sql`(select status from post_status where id = ${posts.id}) in ('limited', 'public')`;

/** いいね・通報など、見える投稿にだけできる操作の前に確かめる */
export async function isPublicPost(db: Db, postId: string): Promise<boolean> {
  if (!POST_ID.test(postId)) return false;
  const [row] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), visible));
  return row !== undefined;
}

/**
 * @param deviceId 形を確かめた `device_id`。渡すと、その端末がいいね済みかを `liked` に入れる。
 *   読むだけなので主体（`actors`）は作らない
 */
export async function readPublicPost(
  db: Db,
  postId: string,
  deviceId?: string | null,
): Promise<PublicPost | null> {
  if (!POST_ID.test(postId)) return null;
  const [row] = await db
    .select({
      id: posts.id,
      title: posts.title,
      handle: users.handle,
      publishedAt: posts.publishedAt,
      liked: deviceId
        ? sql<boolean>`exists (
            select 1 from likes l join actors a on a.id = l.actor_id
            where l.post_id = ${posts.id} and a.device_id = ${deviceId})`
        : sql<boolean>`false`,
      calibration: posts.calibration,
      plays: postStats.n,
      // 選択列の副問い合わせでは表名を自分で書く（drizzle は `${posts.id}` を表名なしの "id" にする）
      likes: sql<number>`(select count(*)::int from likes l where l.post_id = "posts"."id")`,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.userId))
    .leftJoin(postStats, eq(postStats.postId, posts.id))
    .where(and(eq(posts.id, postId), visible));
  // limited / public なら published_at は入っている（I4）
  if (!row?.publishedAt) return null;
  return {
    post_id: row.id,
    title: row.title,
    author: { handle: row.handle },
    published_at: row.publishedAt.toISOString(),
    liked: row.liked,
    stats: row.calibration === "calibrated" ? { plays: row.plays ?? 0, likes: row.likes } : null,
  };
}

/** `score` の問い合わせ文字列。0 以上 `SCORE_MAX` 以下の整数の 10 進表記だけ（pr#A.8 の点数の範囲） */
export function parseScoreQuery(raw: string | undefined): number | null {
  if (raw === undefined || !/^(0|[1-9][0-9]{0,9})$/.test(raw)) return null;
  const score = Number(raw);
  return score <= SCORE_MAX ? score : null;
}

/**
 * ゲームページの「今の偏差値」（product#5.3）。score を今の分布に当てた偏差値（sc#A.5）。読むだけで何も残さない。
 *
 * 値を出すのはランの手番と同じ条件（校正済みで、分布が校正に要る件数以上。`turns.ts`）。それ以外は
 * `{deviation: null}`。見えない投稿（`readPublicPost` と同じ）は null で、呼び出し側が `not_found` を返す。
 */
export async function readDeviation(
  db: Db,
  postId: string,
  score: number,
): Promise<{ deviation: number | null } | null> {
  if (!POST_ID.test(postId)) return null;
  const [row] = await db
    .select({ calibration: posts.calibration, scores: postStats.scores })
    .from(posts)
    .leftJoin(postStats, eq(postStats.postId, posts.id))
    .where(and(eq(posts.id, postId), visible));
  if (!row) return null;
  const scores = row.scores ?? [];
  if (row.calibration !== "calibrated" || scores.length < CALIBRATION_MIN_PLAYS) {
    return { deviation: null };
  }
  // post_stats.scores は昇順（dm#A.3）。並びが崩れていても順位がずれないよう、ここで並べ直す
  return {
    deviation: deviation(
      score,
      [...scores].sort((a, b) => a - b),
    ),
  };
}
