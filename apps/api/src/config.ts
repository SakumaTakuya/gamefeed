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
  /** ログインは Google だけ（spec#9、計画書 第5節）なので必須。無いと認可フローがログインで止まる */
  google: { clientId: string; clientSecret: string };
}

export type ConfigResult = { ok: true; config: ApiConfig } | { ok: false; missing: string[] };

const REQUIRED = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

export function configFromEnv(env: Record<string, string | undefined>): ConfigResult {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) return { ok: false, missing };
  const google = {
    clientId: env.GOOGLE_CLIENT_ID as string,
    clientSecret: env.GOOGLE_CLIENT_SECRET as string,
  };
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
