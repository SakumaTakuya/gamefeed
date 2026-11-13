/**
 * 下書きの試遊トークン（security.md A.5）。
 *
 * 形: base64url(post_id + "." + exp) + "." + base64url(HMAC-SHA256(secret, post_id + "." + exp))。exp は Unix 秒。
 * 検証は配信 Worker（apps/games/src/play-token.ts）が同じ秘密 `GAMES_SIGNING_SECRET` で行う。
 */

import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { posts } from "./db/schema.ts";

/** 発行からの有効期間（se#A.5、暫定） */
export const PLAY_TOKEN_TTL_SEC = 10 * 60;

export function signPlayToken(secret: string, postId: string, exp: number): string {
  const payload = `${postId}.${exp}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

export interface PlayToken {
  token: string;
  /** 期限（Unix 秒）。Host はこれを過ぎる前に取り直す */
  exp: number;
}

/**
 * 作者本人の `draft` にだけトークンを発行する。それ以外（他人・公開済み・非公開・存在しない）は null で、
 * 呼び出し側は理由を区別せず `not_found` を返す（投稿の有無と状態を漏らさない）。
 */
export async function issuePlayToken(
  deps: { db: Db; now: () => Date; secret: string },
  userId: string,
  postId: string,
): Promise<PlayToken | null> {
  const [row] = await deps.db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.id, postId),
        eq(posts.userId, userId),
        // 投稿状態はビュー post_status で導出する（dm#A.4）
        sql`(select status from post_status where id = ${posts.id}) = 'draft'`,
      ),
    );
  if (!row) return null;
  const exp = Math.floor(deps.now().getTime() / 1000) + PLAY_TOKEN_TTL_SEC;
  return { token: signPlayToken(deps.secret, postId, exp), exp };
}
