import { defineConfig } from "drizzle-kit";

// `pnpm --filter @gamefeed/api db:generate` でスキーマの差分 SQL を migrations/ に出す。
// トリガー・ビューは `db:generate:custom` で空の SQL を作り、手で書く。
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  casing: "snake_case",
});
