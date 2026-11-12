/**
 * 環境変数（.env.example）を型のある設定に変換する。
 * 足りなければ `missing` を返し、呼び出し側（app.ts）は認証・MCP だけを 503 にして `/api/health` は生かす。
 */

import type { KvConfig } from "./kv.ts";
import type { R2Config } from "./r2.ts";

export interface ApiConfig {
  /** 外から見える URL（末尾スラッシュなし）。Better Auth の baseURL と MCP リソース識別子の元 */
  baseURL: string;
  /** Better Auth のセッション署名と jwks 暗号化の鍵。32 文字以上 */
  secret: string;
  databaseUrl: string;
  /** ログインは Google だけ（spec#9、計画書 第5節）なので必須。無いと認可フローがログインで止まる */
  google: { clientId: string; clientSecret: string };
  /** R2（mc#A.8）。4 つ揃ったときだけ入る。無ければ `publish_game` は `not_configured`（mc#A.2） */
  r2?: R2Config;
  /** KV `serve:<post_id>` を書く Cloudflare API（se#A.5、A.8）。3 つ揃ったときだけ入る */
  kv?: KvConfig;
  /** `publish_game` に足りない変数名（空なら揃っている） */
  storageMissing: string[];
}

const R2_VARS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET"] as const;
const KV_VARS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID"] as const;

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
  const r2Missing = R2_VARS.filter((k) => !env[k]);
  const kvMissing = KV_VARS.filter((k) => !env[k]);
  return {
    ok: true,
    config: {
      baseURL: (env.BETTER_AUTH_URL as string).replace(/\/+$/, ""),
      secret: env.BETTER_AUTH_SECRET as string,
      databaseUrl: env.DATABASE_URL as string,
      google,
      ...(r2Missing.length === 0
        ? {
            r2: {
              accessKeyId: env.R2_ACCESS_KEY_ID as string,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
              endpoint: env.R2_ENDPOINT as string,
              bucket: env.R2_BUCKET as string,
            },
          }
        : {}),
      ...(kvMissing.length === 0
        ? {
            kv: {
              apiToken: env.CLOUDFLARE_API_TOKEN as string,
              accountId: env.CLOUDFLARE_ACCOUNT_ID as string,
              namespaceId: env.KV_NAMESPACE_ID as string,
            },
          }
        : {}),
      storageMissing: [...r2Missing, ...kvMissing],
    },
  };
}
