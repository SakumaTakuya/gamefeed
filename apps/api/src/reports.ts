/**
 * 通報の受付（moderation.md A.4 の「受付」）。匿名でもでき、主体は端末ごとの `actors`。
 *
 * - 対象は投稿状態が `limited` / `public` / `restricted` の投稿。それ以外と存在しない ID は `not_found`
 * - 1 投稿につき 1 主体 1 回（I14）。2 回目は何もせず成功
 * - 作者自身（`actors.user_id = posts.user_id`）は `invalid`
 * - 重みは受付時に計算して凍結する。匿名は 0（I14。DB のトリガーも 0 に書き換える）
 *
 * 自動制限（mo#A.4 の「自動制限」）はまだ無い。受け付けて記録するだけ。
 */

import { type ReportInput, reportWeight } from "@gamefeed/domain";
import { eq, sql } from "drizzle-orm";
import { ensureActor } from "./actors.ts";
import type { Db } from "./db/client.ts";
import { posts, reports, users } from "./db/schema.ts";

/** ULID（dm#A.1）。形の違う ID は DB を引かずに「無い」 */
const POST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type ReportOutcome = "reported" | "not_found" | "invalid";

export async function reportPost(
  deps: { db: Db; now: () => Date },
  input: { postId: string; deviceId: string; userId: string | null; report: ReportInput },
): Promise<ReportOutcome> {
  if (!POST_ID.test(input.postId)) return "not_found";
  const [post] = await deps.db
    .select({
      userId: posts.userId,
      // 選択列の中の ${posts.id} は表名なしの "id" になり、副問い合わせの中で post_status.id を指してしまう。
      // 表名を書いて外側の posts を指す
      reportable: sql<boolean>`(select ps.status from post_status ps where ps.id = "posts"."id")
        in ('limited', 'public', 'restricted')`,
    })
    .from(posts)
    .where(eq(posts.id, input.postId));
  // 行も主体も作らない
  if (!post?.reportable) return "not_found";

  const actor = await ensureActor(deps, input.deviceId, input.userId);
  if (actor.userId !== null && actor.userId === post.userId) return "invalid";

  let trustScore: number | null = null;
  if (actor.userId !== null) {
    const [reporter] = await deps.db
      .select({ trustScore: users.trustScore })
      .from(users)
      .where(eq(users.id, actor.userId));
    trustScore = reporter?.trustScore ?? null;
  }

  await deps.db
    .insert(reports)
    .values({
      postId: input.postId,
      actorId: actor.id,
      category: input.report.category,
      comment: input.report.comment,
      weight: reportWeight(trustScore, input.report.category),
      createdAt: deps.now(),
    })
    // 2 回目は最初の行を残す（カテゴリも重みも変えない）
    .onConflictDoNothing();
  return "reported";
}
