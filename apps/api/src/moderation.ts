/**
 * 運営の操作（moderation.md A.7）。いまあるのは `restore`（`post_id`）だけで、ほかは W6（plan#11）。
 *
 * `restore`（`post_id`）:
 * - `indiv_restricted = false`。対象は基本状態が `limited` / `public` / `unpublished`（`draft` / `removed` は `invalid_state`）
 * - 対象が `limited` かつ `calibrated` で `upheld` の通報が無ければ `public` に昇格する（mo#A.2、B.9）
 * - その投稿の `open` の通報を `dismissed` にし、通報者の信頼スコアを −2 ずつ（mo#A.5。投稿ごとに 1 回、
 *   0 で止まり、0 になったら `post_restricted`）。作者の信頼スコアは戻さない
 * - `moderation_actions` に 1 行。状態の変更と同じトランザクション（I6）
 * - 確定後に KV `serve:<post_id>` を合わせる（se#A.5）
 *
 * ツリー制限（`tree_locks`）は触らない。ツリー制限が効いていれば投稿状態は `restricted` のまま（mo#A.6）。
 * 誰が呼べるか（se#A.8 の `MODERATOR_IDS`）は呼び出し側（app.ts）が先に確かめる。
 */

import { TRUST_DELTA_REPORT_DISMISSED } from "@gamefeed/domain";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { moderationActions, posts, reports, users } from "./db/schema.ts";
import { type PostStatus, type ServeKv, statusOf, syncServe } from "./publish.ts";

/** ULID（dm#A.1）。形の違う ID は DB を引かずに「無い」 */
const POST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `{reason}` を確かめる。`reason` は必須（mo#A.7）。前後の空白を落として空なら null */
export function parseModerationReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { reason } = body as { reason?: unknown };
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed;
}

export type RestoreError = "forbidden" | "not_found" | "invalid_state";

export interface Restored {
  post_id: string;
  /** 復帰後の投稿状態。ツリー制限が残っていれば `restricted`、作者が非公開にしていれば `unpublished` */
  status: PostStatus;
  /** `dismissed` にした通報の数 */
  dismissed: number;
  /** KV `serve:<post_id>` を書けたか。false なら配信は前のままで、同じ呼び出しをもう一度すると書き直す */
  served: boolean;
}

export async function restorePost(
  deps: { db: Db; now: () => Date; kv: ServeKv },
  input: { postId: string; moderatorId: string; reason: string },
): Promise<{ ok: true; value: Restored } | { ok: false; error: RestoreError }> {
  if (!POST_ID.test(input.postId)) return { ok: false, error: "not_found" };

  const done = await deps.db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    // 監査行の moderator_id は users を指す。users 行の無いログイン（遊ぶだけの人）は運営になれない
    const [moderator] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.moderatorId));
    if (!moderator) return "forbidden" as const;

    // 通報の受付（reportPost）と同じ行ロック。合計の判定と入れ違いにならない
    const [post] = await tx
      .select({ baseStatus: posts.baseStatus })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .for("update");
    if (!post) return "not_found" as const;
    if (post.baseStatus === "draft" || post.baseStatus === "removed") {
      return "invalid_state" as const;
    }

    const dismissed = await tx
      .update(reports)
      .set({ resolution: "dismissed" })
      .where(and(eq(reports.postId, input.postId), eq(reports.resolution, "open")))
      .returning({ id: reports.id });

    if (dismissed.length > 0) {
      const ids = sql.join(
        dismissed.map((r) => sql`${r.id}`),
        sql`, `,
      );
      // 通報者 −2（mo#A.5）。匿名（actors.user_id が NULL）は users に当たらない。
      // 投稿ごとに 1 回: この投稿で前に退けられたことのある通報者（別の端末からの通報を含む）は減らさない。
      // 0 で止め、0 になった active は post_restricted にする（banned はそのまま）
      await tx.execute(sql`
        update users u set
          trust_score = greatest(u.trust_score + ${TRUST_DELTA_REPORT_DISMISSED}, 0),
          status = case
            when u.status = 'active' and u.trust_score + ${TRUST_DELTA_REPORT_DISMISSED} <= 0
              then 'post_restricted'::user_status
            else u.status end
        where u.id in (
            select a.user_id from reports r join actors a on a.id = r.actor_id
            where r.id in (${ids}) and a.user_id is not null)
          and not exists (
            select 1 from reports r join actors a on a.id = r.actor_id
            where r.post_id = ${input.postId} and r.resolution = 'dismissed'
              and a.user_id = u.id and r.id not in (${ids}))`);
    }

    // 制限を下ろし、昇格の条件を見直す（mo#A.7、B.9）。upheld はこの操作では増えも減りもしない
    await tx.execute(sql`
      update posts set
        indiv_restricted = false,
        base_status = case
          when base_status = 'limited' and calibration = 'calibrated' and not exists (
            select 1 from reports r where r.post_id = posts.id and r.resolution = 'upheld')
            then 'public'::base_status
          else base_status end
      where id = ${input.postId}`);

    await tx.insert(moderationActions).values({
      moderatorId: input.moderatorId,
      kind: "restore",
      postId: input.postId,
      reason: input.reason,
      createdAt: deps.now(),
    });
    return { dismissed: dismissed.length, status: await statusOf(tx, input.postId) };
  });
  if (typeof done === "string") return { ok: false, error: done };

  // 配信を戻す（se#A.5）。書けなくても復帰は確定している。served: false を返し、呼び直しで書き直す
  const served = await syncServe(deps.db, deps.kv, input.postId);
  if (!served) console.error(`復帰した投稿 ${input.postId} の配信の再開が KV に反映されていない`);
  return {
    ok: true,
    value: { post_id: input.postId, status: done.status, dismissed: done.dismissed, served },
  };
}
