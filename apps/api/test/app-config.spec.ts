import { describe, expect, it } from "vitest";
import { createAppFromEnv } from "../src/app.ts";
import { configFromEnv } from "../src/config.ts";

describe("設定不足のときの app（Vercel のプレビュー等、#5）", () => {
  it("configFromEnv は足りない変数名を返す", () => {
    const r = configFromEnv({ DATABASE_URL: "postgresql://x" });
    expect(r).toEqual({
      ok: false,
      missing: [
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
      ],
    });
  });

  it("BETTER_AUTH_URL の末尾スラッシュは落とす。Google の資格情報は必須（ログインは Google だけ）", () => {
    const r = configFromEnv({
      DATABASE_URL: "postgresql://x",
      BETTER_AUTH_SECRET: "s".repeat(32),
      BETTER_AUTH_URL: "https://example.test/",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(r.ok && r.config.baseURL).toBe("https://example.test");
    expect(r.ok && r.config.google).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("health は生き、認証・MCP・.well-known は 503 と不足一覧を返す", async () => {
    const app = createAppFromEnv({});
    expect((await app.request("/api/health")).status).toBe(200);
    for (const path of [
      "/api/auth/get-session",
      "/api/mcp",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      const res = await app.request(path, { method: path === "/api/mcp" ? "POST" : "GET" });
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({
        error: "not_configured",
        missing: [
          "DATABASE_URL",
          "BETTER_AUTH_SECRET",
          "BETTER_AUTH_URL",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
        ],
      });
    }
  });
});
