/**
 * 遊ぶ側の主体（data-model.md A.1、A.3）。匿名を含む。`device_id` ごとに 1 行。
 *
 * `device_id` はクライアントが作る 128 bit の乱数で、認証ではない。受け渡し（ヘッダ `X-Device-Id`）と形、
 * `user_id` を埋める時点は文書に無く、#141 の案で実装している。
 */

import { sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { ulid } from "./id.ts";

/** 主体が要る API はこのヘッダで `device_id` を受ける（#141） */
export const DEVICE_ID_HEADER = "x-device-id";

/** 128 bit の乱数の表記: base64url 22 文字、hex 32 文字、ハイフン付き UUID 36 文字が通る（#141） */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** ヘッダの値が `device_id` の形ならそのまま返す。無い・形式外は null（呼び出し側は 400 `invalid_device`） */
export function parseDeviceId(value: string | undefined | null): string | null {
  return typeof value === "string" && DEVICE_ID_RE.test(value) ? value : null;
}

export interface Actor {
  id: string;
  /** ログインした端末は埋まる。匿名は null */
  userId: string | null;
}

/**
 * `device_id` から主体を upsert する（dm#A.3「匿名の初回アクセスで upsert」）。同じ `device_id` は同じ主体。
 *
 * userId（ログイン中の利用者）を渡すと、主体の `user_id` が NULL で、その利用者に `users` 行があるときだけ埋める。
 * 一度埋まった `user_id` は変えない（I17）。`users` 行のない利用者（遊ぶだけの人）では埋めない（FK が users を指す）。
 */
export async function ensureActor(
  deps: { db: Db; now: () => Date },
  deviceId: string,
  userId?: string | null,
): Promise<Actor> {
  // 同時の初回アクセスでも 1 行になるよう、ON CONFLICT で既存の行を返す（値は変えない）
  const [row] = await deps.db.execute<{ id: string; user_id: string | null }>(sql`
    insert into actors (id, device_id, created_at)
    values (${ulid(deps.now().getTime())}, ${deviceId}, ${deps.now().toISOString()}::timestamptz)
    on conflict (device_id) do update set device_id = excluded.device_id
    returning id, user_id`);
  if (!row) throw new Error("actors の upsert が行を返さなかった");
  if (!userId || row.user_id !== null) return { id: row.id, userId: row.user_id };

  const [linked] = await deps.db.execute<{ user_id: string }>(sql`
    update actors set user_id = ${userId}
    where id = ${row.id} and user_id is null
      and exists (select 1 from users where id = ${userId})
    returning user_id`);
  if (linked) return { id: row.id, userId: linked.user_id };
  // users 行が無いか、同時の別リクエストが先に埋めた。今の値を読み直す
  const [current] = await deps.db.execute<{ user_id: string | null }>(
    sql`select user_id from actors where id = ${row.id}`,
  );
  return { id: row.id, userId: current?.user_id ?? null };
}
