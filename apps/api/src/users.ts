/**
 * 作る側の `users` 行（mcp.md A.5）。
 *
 * Better Auth のユーザーは `auth_user` に入り、`users`（handle・trust_score・status）は別の行。
 * ツールの呼び出しと「作る」ページの最初のリクエストが、トランザクションの先頭で `ensureUser` を呼ぶ。
 */

import { handleBase, handleCandidate } from "@gamefeed/domain";
import { eq } from "drizzle-orm";
import { user as authUser } from "./db/auth-schema.ts";
import type { Db } from "./db/client.ts";
import { users } from "./db/schema.ts";

/** 信頼スコアの初期値（mo#A.5、暫定） */
export const TRUST_INITIAL = 10;

/** handle の候補を試す上限。同じ slug の人がこれだけいたら設計を見直す */
const HANDLE_ATTEMPTS = 1000;

export interface UserRow {
  id: string;
  handle: string;
  trustScore: number;
  status: "active" | "post_restricted" | "banned";
}

const columns = {
  id: users.id,
  handle: users.handle,
  trustScore: users.trustScore,
  status: users.status,
};

/**
 * `users` 行がなければ作り、行を返す（mc#A.5）。既にあれば何も変えない。
 *
 * handle の衝突は `ON CONFLICT DO NOTHING`（対象なし = id と handle のどちらの衝突も黙って捨てる）で受け、
 * 入らなかったら「同じ id が先に入った」か「handle が取られていた」かを見分けて次の候補に進む。
 * UNIQUE 違反を例外で受けると呼び出し側のトランザクションが abort するので、例外にしない。
 */
export async function ensureUser(tx: Db, id: string): Promise<UserRow> {
  const existing = await tx.select(columns).from(users).where(eq(users.id, id));
  if (existing[0]) return existing[0];

  const [auth] = await tx.select({ name: authUser.name }).from(authUser).where(eq(authUser.id, id));
  if (!auth) throw new Error(`ensureUser: auth_user に ${id} がいない`);

  const base = handleBase(auth.name, id);
  for (let n = 1; n <= HANDLE_ATTEMPTS; n++) {
    const inserted = await tx
      .insert(users)
      .values({ id, handle: handleCandidate(base, n), trustScore: TRUST_INITIAL, status: "active" })
      .onConflictDoNothing()
      .returning(columns);
    if (inserted[0]) return inserted[0];
    // 同じ id の行が並行して入った場合はそれを返す
    const raced = await tx.select(columns).from(users).where(eq(users.id, id));
    if (raced[0]) return raced[0];
  }
  throw new Error(`ensureUser: handle の候補が ${HANDLE_ATTEMPTS} 個すべて使われている（${base}）`);
}
