/**
 * `list_my_games` と `unpublish_game` の本体（mcp.md A.3、moderation.md A.2 の `unpublish` の行）。
 * どちらも DB だけで動く（mc#A.2）。KV があれば `unpublish_game` が `serve:<post_id>` を `no` にする（se#A.5）。
 */

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { likes, postStats, posts, reports } from "./db/schema.ts";
import {
  fail,
  lockUser,
  NOT_FOUND,
  type PostStatus,
  type PublishDeps,
  statusOf,
  type ToolOutcome,
  writeServe,
} from "./publish.ts";

/** 一覧の上限（mc#A.3、暫定） */
export const LIST_LIMIT = 50;
/** 校正に要るプレイ数（sc#A.4。`calibration_remaining = 20 − n`） */
export const CALIBRATION_N = 20;

export interface MyGame {
  post_id: string;
  title: string;
  status: PostStatus;
  url: string;
  calibration: "uncalibrated" | "calibrated" | "review" | "invalid";
  plays: number;
  likes: number;
  /** `uncalibrated` のときだけ */
  calibration_remaining?: number;
  /** `restricted` のときだけ。通報カテゴリごとの件数（`dismissed` を除く） */
  restricted_reason?: Record<string, number>;
  published_at: string | null;
  updated_at: string;
}

export async function listMyGames(
  deps: PublishDeps,
  userId: string,
): Promise<ToolOutcome<{ games: MyGame[] }>> {
  return deps.db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    const me = await lockUser(tx, userId);
    if ("ok" in me) return me;

    const rows = await tx
      .select({
        id: posts.id,
        title: posts.title,
        calibration: posts.calibration,
        publishedAt: posts.publishedAt,
        updatedAt: posts.updatedAt,
        plays: postStats.n,
      })
      .from(posts)
      .leftJoin(postStats, eq(postStats.postId, posts.id))
      .where(eq(posts.userId, userId))
      .orderBy(desc(posts.updatedAt), desc(posts.id))
      .limit(LIST_LIMIT);
    if (rows.length === 0) return { ok: true, value: { games: [] } };
    const ids = rows.map((r) => r.id);

    const statusRows = (await tx.execute(
      sql`select id, status from post_status where id in ${ids}`,
    )) as unknown as { id: string; status: PostStatus }[];
    const status = new Map(statusRows.map((r) => [r.id, r.status]));

    const likeRows = await tx
      .select({ postId: likes.postId, n: sql<number>`count(*)::int` })
      .from(likes)
      .where(inArray(likes.postId, ids))
      .groupBy(likes.postId);
    const likeCount = new Map(likeRows.map((r) => [r.postId, r.n]));

    const restricted = ids.filter((id) => status.get(id) === "restricted");
    const reasons = new Map<string, Record<string, number>>();
    if (restricted.length > 0) {
      const reportRows = await tx
        .select({
          postId: reports.postId,
          category: reports.category,
          n: sql<number>`count(*)::int`,
        })
        .from(reports)
        .where(and(inArray(reports.postId, restricted), ne(reports.resolution, "dismissed")))
        .groupBy(reports.postId, reports.category);
      for (const r of reportRows) {
        const m = reasons.get(r.postId) ?? {};
        m[r.category] = r.n;
        reasons.set(r.postId, m);
      }
    }

    const games = rows.map((r): MyGame => {
      const st = status.get(r.id);
      if (!st) throw new Error(`listMyGames: post_status に ${r.id} がない`);
      const plays = r.plays ?? 0;
      return {
        post_id: r.id,
        title: r.title,
        status: st,
        url: `${deps.appOrigin}/${st === "draft" ? "draft" : "g"}/${r.id}`,
        calibration: r.calibration,
        plays,
        likes: likeCount.get(r.id) ?? 0,
        ...(r.calibration === "uncalibrated"
          ? { calibration_remaining: Math.max(0, CALIBRATION_N - plays) }
          : {}),
        ...(st === "restricted" ? { restricted_reason: reasons.get(r.id) ?? {} } : {}),
        published_at: r.publishedAt ? r.publishedAt.toISOString() : null,
        updated_at: r.updatedAt.toISOString(),
      };
    });
    return { ok: true, value: { games } };
  });
}

export async function unpublishGame(
  deps: PublishDeps,
  userId: string,
  input: { post_id: string },
): Promise<ToolOutcome<{ post_id: string; status: PostStatus }>> {
  const done = await deps.db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    const me = await lockUser(tx, userId);
    if ("ok" in me) return me;

    const [p] = await tx
      .select({
        id: posts.id,
        userId: posts.userId,
        baseStatus: posts.baseStatus,
        gameHash: posts.gameHash,
      })
      .from(posts)
      .where(eq(posts.id, input.post_id))
      .for("update");
    if (!p || p.userId !== userId) return fail("not_found", NOT_FOUND);
    if (p.baseStatus === "removed") {
      return fail(
        "invalid_state",
        "この投稿は運営によって削除されているので、非公開にできません。",
      );
    }
    // unpublished / draft には何もせず成功。制限（indiv_restricted、tree_locks）と通報は触らない
    const changed = p.baseStatus === "limited" || p.baseStatus === "public";
    if (changed) {
      await tx.update(posts).set({ baseStatus: "unpublished" }).where(eq(posts.id, p.id));
    }
    return { postId: p.id, hash: p.gameHash, status: await statusOf(tx, p.id), changed };
  });
  if ("ok" in done) return done;

  if (done.changed && deps.kv) {
    await writeServe(deps.kv, done.postId, { hash: done.hash, status: "no" });
  }
  return { ok: true, value: { post_id: done.postId, status: done.status } };
}
