/**
 * 公開済みの投稿を読む（`GET /api/posts/{id}`。ゲームページ `/g/<post_id>` が使う。run.md A.14）。
 *
 * 見えるのは投稿状態が `limited` / `public` のものだけ（moderation.md A.3 の「直リンク」、mcp.md A.9）。
 * それ以外（`draft` / `restricted` / `unpublished` / `removed`、存在しない ID）は null で、呼び出し側は
 * 理由を区別せず `not_found` を返す。作者が呼んでも同じ（作者が見るのは試遊ページと「作る」ページ）。
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { posts, users } from "./db/schema.ts";

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
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.userId))
    .where(and(eq(posts.id, postId), visible));
  // limited / public なら published_at は入っている（I4）
  if (!row?.publishedAt) return null;
  return {
    post_id: row.id,
    title: row.title,
    author: { handle: row.handle },
    published_at: row.publishedAt.toISOString(),
    liked: row.liked,
  };
}
