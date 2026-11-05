/**
 * Better Auth（Google ログイン）＋ OAuth 2.1 認可サーバ（@better-auth/mcp）。plan#9・spec#9、計画書 第5節。
 *
 * - 認可サーバはアプリ本体と同居し、issuer は `${baseURL}/api/auth`。
 * - MCP の保護リソースは `${baseURL}/api/mcp`（アクセストークン JWT の aud）。
 * - クライアント登録は CIMD（MCP 2026-07-28）と DCR（Claude コネクタ等の既存クライアント）の両方を受ける。
 *   DCR は Better Auth では明示的に有効化しないと登録エンドポイントが出ない。
 * - トークン方針（計画書 第5節）: アクセストークン 24h、リフレッシュトークン 30 日、
 *   ローテーション後の旧リフレッシュトークンに 60 秒の猶予（同じ応答を再送する）。
 */

import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { authSchema } from "./db/auth-schema.ts";
import type { Db } from "./db/client.ts";

export const AUTH_BASE_PATH = "/api/auth";
export const MCP_PATH = "/api/mcp";
/** ログイン・同意の画面。PoC では API が最小の HTML を返す（pages.ts）。W5 で SPA に移す */
export const SIGN_IN_PAGE = "/api/connect/sign-in";
export const CONSENT_PAGE = "/api/connect/consent";

export const ACCESS_TOKEN_EXPIRES_IN = 24 * 60 * 60; // 24h（計画書: 24 時間以上）
export const REFRESH_TOKEN_EXPIRES_IN = 30 * 24 * 60 * 60; // 30 日
export const REFRESH_TOKEN_REUSE_INTERVAL = 60; // 秒。旧リフレッシュトークンの猶予
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];

export interface AuthOptions {
  baseURL: string;
  secret: string;
  db: Db;
  google?: { clientId: string; clientSecret: string } | undefined;
  /** テスト専用（better-auth/plugins の testUtils など）。本番では渡さない */
  extraPlugins?: BetterAuthPlugin[];
}

export function mcpResource(baseURL: string): string {
  return `${baseURL}${MCP_PATH}`;
}

export function createAuth(opts: AuthOptions) {
  const resource = mcpResource(opts.baseURL);
  return betterAuth({
    baseURL: opts.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: opts.secret,
    database: drizzleAdapter(opts.db, { provider: "pg", schema: authSchema }),
    socialProviders: opts.google
      ? { google: { clientId: opts.google.clientId, clientSecret: opts.google.clientSecret } }
      : {},
    plugins: [
      jwt(),
      mcp({
        loginPage: SIGN_IN_PAGE,
        consentPage: CONSENT_PAGE,
        resource,
        scopes: OAUTH_SCOPES,
        accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
        refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
        refreshTokenReuseInterval: REFRESH_TOKEN_REUSE_INTERVAL,
        // DCR（RFC 7591）。Claude のコネクタは application_type を省く／localhost コールバックを使う
        // クライアントがあるため "infer" で native と判定させる（Better Auth docs「Optional DCR fallback」）
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      ...(opts.extraPlugins ?? []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
