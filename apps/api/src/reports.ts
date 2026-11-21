/**
 * 通報の受付（moderation.md A.4 の「受付」）。匿名でもでき、主体は端末ごとの `actors`。
 *
 * - 対象は投稿状態が `limited` / `public` / `restricted` の投稿。それ以外と存在しない ID は `not_found`
 * - 1 投稿につき 1 主体 1 回（I14）。2 回目は何もせず成功
 * - 作者自身（`actors.user_id = posts.user_id`）は `invalid`
 * - 重みは受付時に計算して凍結する。匿名は 0（I14。DB のトリガーも 0 に書き換える）
 *
 * 自動制限（mo#A.4 の「自動制限」）: 通報を受け付けるたびに、その投稿の `open` の通報の重みを合計し、
 * 閾値を超えていれば `indiv_restricted = true` にして、`moderation_actions` に `moderator_id = NULL` の
 * `restrict` を残す。通報の挿入・判定・制限・監査行は 1 つのトランザクション（I6）。通報は `open` のまま、
 * 信頼スコアも変えない。確定後に KV `serve:<post_id>` を合わせる（se#A.5）。
 */

import { autoRestrict, type ReportInput, reportWeight } from "@gamefeed/domain";
import { and, eq, sql } from "drizzle-orm";
import { ensureActor } from "./actors.ts";
import type { Db } from "./db/client.ts";
import { moderationActions, posts, reports, users } from "./db/schema.ts";
import { type ServeKv, syncServe } from "./publish.ts";

/** ULID（dm#A.1）。形の違う ID は DB を引かずに「無い」 */
const POST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type ReportOutcome = "reported" | "not_found" | "invalid";

export async function reportPost(
  deps: { db: Db; now: () => Date; kv?: ServeKv | undefined },
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

  const weight = reportWeight(trustScore, input.report.category);
  const restricted = await deps.db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    // 同じ投稿への通報を直列にする（合計を読む間に別の通報が確定して、監査行が 2 つできるのを防ぐ）
    const [locked] = await tx
      .select({ indivRestricted: posts.indivRestricted })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .for("update");
    // 通報の検査の後に下書きが消えた。行が無ければ通報も入らない
    if (!locked) return false;

    await tx
      .insert(reports)
      .values({
        postId: input.postId,
        actorId: actor.id,
        category: input.report.category,
        comment: input.report.comment,
        weight,
        createdAt: deps.now(),
      })
      // 2 回目は最初の行を残す（カテゴリも重みも変えない）
      .onConflictDoNothing();
    // 制限は自動では解けず、重ねても変わらない。監査行も重ねない
    if (locked.indivRestricted) return true;

    const tallies = await tx
      .select({
        category: reports.category,
        weight: sql<number>`sum(${reports.weight})::float8`,
        count: sql<number>`count(*)::int`,
      })
      .from(reports)
      .where(and(eq(reports.postId, input.postId), eq(reports.resolution, "open")))
      .groupBy(reports.category);
    const decision = autoRestrict(tallies);
    if (!decision.restrict) return false;

    await tx.update(posts).set({ indivRestricted: true }).where(eq(posts.id, input.postId));
    await tx.insert(moderationActions).values({
      moderatorId: null,
      kind: "restrict",
      postId: input.postId,
      reason: decision.reason,
      createdAt: deps.now(),
    });
    return true;
  });

  // 配信を止める（se#A.5）。制限済みの投稿でも書き直すので、前回 KV だけ失敗していても次の通報で直る。
  // 書けなくても通報は成功として返す（DB の制限は確定していて、API からはもう見えない。日次の突き合わせも直す）
  if (restricted && deps.kv) {
    if (!(await syncServe(deps.db, deps.kv, input.postId))) {
      console.error(`自動制限した投稿 ${input.postId} の配信の停止が KV に反映されていない`);
    }
  }
  return "reported";
}
