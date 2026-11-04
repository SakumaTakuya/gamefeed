/**
 * 環境変数（.env.example）を型のある設定に変換する。
 * 足りなければ `missing` を返し、呼び出し側（app.ts）は認証・MCP だけを 503 にして `/api/health` は生かす。
 */

export interface ApiConfig {
  /** 外から見える URL（末尾スラッシュなし）。Better Auth の baseURL と MCP リソース識別子の元 */
  baseURL: string;
  /** Better Auth のセッション署名と jwks 暗号化の鍵。32 文字以上 */
  secret: string;
  databaseUrl: string;
  google?: { clientId: string; clientSecret: string } | undefined;
}

export type ConfigResult = { ok: true; config: ApiConfig } | { ok: false; missing: string[] };

const REQUIRED = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"] as const;

export function configFromEnv(env: Record<string, string | undefined>): ConfigResult {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) return { ok: false, missing };
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : undefined;
  return {
    ok: true,
    config: {
      baseURL: (env.BETTER_AUTH_URL as string).replace(/\/+$/, ""),
      secret: env.BETTER_AUTH_SECRET as string,
      databaseUrl: env.DATABASE_URL as string,
      google,
    },
  };
}
