import { Hono } from "hono";

// REST API・Better Auth・MCP サーバはすべてこの app に載せる。
// Vercel からは /api/index.ts 経由で、ローカルは src/dev.ts から起動する。
export const app = new Hono().basePath("/api");

app.get("/health", (c) => c.json({ ok: true, service: "gamefeed-api" }));

export type App = typeof app;
