/**
 * Better Auth（ログイン・セッション）と OAuth 2.1 認可サーバ（@better-auth/mcp）が使うテーブル。
 *
 * 元は `npx @better-auth/cli generate` の出力。spec#12 の `users` / `sessions` と名前が衝突しないよう
 * テーブル名に `auth_` を付け、drizzle のキー名（user / session / …）は Better Auth のモデル名のまま残す
 * （`drizzleAdapter` はキー名でモデルを引く）。列の追加・削除は Better Auth 側の要求に従う。
 * アプリの `users` 行（handle・trust_score）とは `id` で結ぶ（作成はplan#9 の API 実装で行う）。
 */

import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("auth_account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

/** jwt プラグインの署名鍵。private_key は BETTER_AUTH_SECRET で暗号化されて入る。 */
export const jwks = pgTable("auth_jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: ts("created_at").notNull(),
  expiresAt: ts("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes").array(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_client_user_id_idx").on(t.userId)],
);

export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("oauth_client_resource_client_id_idx").on(t.clientId),
    index("oauth_client_resource_resource_id_idx").on(t.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at"),
    revoked: ts("revoked"),
    rotatedAt: ts("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: ts("rotation_replay_expires_at"),
    authTime: ts("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_id_idx").on(t.clientId),
    index("oauth_refresh_token_session_id_idx").on(t.sessionId),
    index("oauth_refresh_token_user_id_idx").on(t.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at"),
    revoked: ts("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_access_token_client_id_idx").on(t.clientId),
    index("oauth_access_token_session_id_idx").on(t.sessionId),
    index("oauth_access_token_user_id_idx").on(t.userId),
    index("oauth_access_token_authorization_code_id_idx").on(t.authorizationCodeId),
    index("oauth_access_token_refresh_id_idx").on(t.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("oauth_consent_client_id_idx").on(t.clientId),
    index("oauth_consent_user_id_idx").on(t.userId),
  ],
);

/** private_key_jwt のアサーション jti を 1 回限りにするための行。 */
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
});

export const authSchema = {
  user,
  session,
  account,
  verification,
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
};
