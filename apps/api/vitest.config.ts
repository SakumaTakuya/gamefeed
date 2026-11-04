import { defineConfig } from "vitest/config";

// integration テスト（db.spec / mcp-oauth.spec）は同じ DATABASE_URL を resetDb するので、ファイルを直列に回す。
export default defineConfig({
  test: { fileParallelism: false },
});
