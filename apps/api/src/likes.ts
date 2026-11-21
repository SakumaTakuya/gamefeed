/**
 * いいね（product.md 3 の 5、data-model.md A.3 の likes）。匿名でもでき、主体は端末ごとの `actors`。
 * 1 投稿につき 1 主体 1 回（I14。pk `(post_id, actor_id)`）で、2 回目は何も変えずに同じ結果を返す。
 * 取り消しは文書に無いので作っていない。
 */

import { ensureActor } from "./actors.ts";
import type { Db } from "./db/client.ts";
import { likes } from "./db/schema.ts";
import { isPublicPost } from "./post-read.ts";

/**
 * @returns 見えない投稿（`limited` / `public` 以外、存在しない ID）なら false。行も主体も作らない
 */
export async function likePost(
  deps: { db: Db; now: () => Date },
  input: { postId: string; deviceId: string; userId?: string | null },
): Promise<boolean> {
  if (!(await isPublicPost(deps.db, input.postId))) return false;
  const actor = await ensureActor(deps, input.deviceId, input.userId);
  await deps.db
    .insert(likes)
    .values({ postId: input.postId, actorId: actor.id, createdAt: deps.now() })
    .onConflictDoNothing();
  return true;
}
