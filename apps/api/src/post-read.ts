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
}

export async function readPublicPost(db: Db, postId: string): Promise<PublicPost | null> {
  if (!POST_ID.test(postId)) return null;
  const [row] = await db
    .select({
      id: posts.id,
      title: posts.title,
      handle: users.handle,
      publishedAt: posts.publishedAt,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.userId))
    .where(
      and(
        eq(posts.id, postId),
        // 投稿状態はビュー post_status で導出する（dm#A.4。制限は indiv_restricted と tree_locks から）
        sql`(select status from post_status where id = ${posts.id}) in ('limited', 'public')`,
      ),
    );
  // limited / public なら published_at は入っている（I4）
  if (!row?.publishedAt) return null;
  return {
    post_id: row.id,
    title: row.title,
    author: { handle: row.handle },
    published_at: row.publishedAt.toISOString(),
  };
}
