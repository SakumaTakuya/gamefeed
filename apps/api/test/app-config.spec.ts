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

  const base = {
    DATABASE_URL: "postgresql://x",
    BETTER_AUTH_SECRET: "s".repeat(32),
    BETTER_AUTH_URL: "https://example.test",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
  };
  const storageEnv = {
    R2_ACCESS_KEY_ID: "akid",
    R2_SECRET_ACCESS_KEY: "sk",
    R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_BUCKET: "gamefeed-games",
    CLOUDFLARE_API_TOKEN: "token",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    KV_NAMESPACE_ID: "ns",
  };

  it("mc#A.2 R2_* と KV の変数は任意。無くても ok で、publish に足りない変数名が storageMissing に入る", () => {
    const r = configFromEnv(base);
    expect(r.ok && r.config.r2).toBeUndefined();
    expect(r.ok && r.config.kv).toBeUndefined();
    expect(r.ok && r.config.storageMissing).toEqual(Object.keys(storageEnv));
  });

  it("mc#A.8 R2_* が 4 つ、KV の変数が 3 つ揃えば r2 / kv が入る。片方だけ・一部だけなら入らない", () => {
    const full = configFromEnv({ ...base, ...storageEnv });
    expect(full.ok && full.config.r2).toEqual({
      accessKeyId: "akid",
      secretAccessKey: "sk",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "gamefeed-games",
    });
    expect(full.ok && full.config.kv).toEqual({ apiToken: "token", accountId: "acct", namespaceId: "ns" });
    expect(full.ok && full.config.storageMissing).toEqual([]);

    const { R2_BUCKET: _b, KV_NAMESPACE_ID: _n, ...partial } = storageEnv;
    const r = configFromEnv({ ...base, ...partial });
    expect(r.ok && r.config.r2).toBeUndefined();
    expect(r.ok && r.config.kv).toBeUndefined();
    expect(r.ok && r.config.storageMissing).toEqual(["R2_BUCKET", "KV_NAMESPACE_ID"]);
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
