/**
 * Postgres への接続と、マイグレーションの適用・初期化。
 *
 * `createDb` は API 本体とテストが共用する。`migrateDb` / `resetDb` は運用スクリプトとテスト用で、
 * リクエスト処理からは呼ばない。マイグレーションの正は `migrations/`（drizzle-kit が生成した SQL）。
 */

import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
  /** postgres-js に渡した実際の接続オプション（テストで確かめる用。実行時には触らない） */
  options: { max: number; connect_timeout: number };
}

export interface CreateDbOptions {
  /** 接続プールの上限。サーバーレス 1 インスタンスあたり。テストは 1 にして挙動を決定的にする */
  max?: number;
  /**
   * 接続確立の待ち時間（秒）。既定 5。
   * postgres-js の既定 30 秒では、DB に届かないとき Better Auth の初期化がそこで止まり、
   * Vercel の関数制限（10 秒）に先に当たって原因の見えない 504 になる（#40）。
   */
  connectTimeout?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_SEC = 5;

const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * 接続プールを作る。Supabase の pooler（Transaction mode）を通すので prepared statement は使わない。
 * 届かない DB には `connectTimeout` 秒で `CONNECT_TIMEOUT` を返し、呼び出し側が原因を切り分けられるようにする。
 */
export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const options = {
    max: opts.max ?? 5,
    connect_timeout: opts.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SEC,
  };
  const client = postgres(url, {
    ...options,
    prepare: false,
    // "already exists, skipping" 等の NOTICE をログに出さない
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), close: () => client.end(), options };
}

/** `migrations/` の未適用分を順に当てる。適用済みは `drizzle.__drizzle_migrations` で判定し、2 回目は何もしない。 */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/**
 * スキーマを空に戻す（テスト専用）。`public` だけでなく drizzle の適用記録（`drizzle` スキーマ）も消さないと
 * `migrateDb` が「適用済み」と判断して何も作らない。
 */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
}
