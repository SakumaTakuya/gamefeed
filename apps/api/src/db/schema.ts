/**
 * spec#12 データモデル（12.1 テーブル、12.2 不変条件のうち DB で担保するもの、12.4 ミクロゲーム対応）。
 *
 * ここに書けるのは列・型・UNIQUE・FK・CHECK・索引まで。トリガーとビューは
 * `migrations/` の custom マイグレーション（`drizzle-kit generate --custom`）に SQL で書く。
 * 列挙型の値の順序は spec#12.1 の記載順（R-12.1-1）。
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---- 列挙型（spec#12.1 / 12.4） -----------------------------------------------

export const userStatus = pgEnum("user_status", ["active", "post_restricted", "banned"]);
export const baseStatus = pgEnum("base_status", [
  "pending",
  "limited",
  "public",
  "removed",
  "expired",
]);
export const sessionState = pgEnum("session_state", ["open", "submitted", "abandoned"]);
export const sessionMode = pgEnum("session_mode", ["play", "replay"]);
export const verdict = pgEnum("verdict", ["provisional", "accepted", "rejected", "flagged"]);
export const reportResolution = pgEnum("report_resolution", ["open", "upheld", "dismissed"]);
export const moderationKind = pgEnum("moderation_kind", [
  "restrict",
  "restore",
  "remove",
  "restrict_tree",
  "restore_tree",
  "ban_user",
]);
export const assetType = pgEnum("asset_type", ["image", "sfx", "bgm", "model", "font"]);
export const assetSource = pgEnum("asset_source", ["library", "user"]);
export const themeStatus = pgEnum("theme_status", ["draft", "open", "closed"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---- users ----------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(),
  trustScore: integer("trust_score").notNull().default(10),
  status: userStatus("status").notNull().default("active"),
  createdAt: createdAt(),
});

// ---- themes（spec#12.4）。games より先に定義する（games.theme_id が参照する） ------------

export const themes = pgTable("themes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  status: themeStatus("status").notNull().default("draft"),
  opensAt: timestamp("opens_at", { withTimezone: true }),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

// ---- games ----------------------------------------------------------------------

/** HTML 本体はハッシュで重複排除。不変（spec#12.1）。verb / input / duration_frames は静的解析が書く（spec#12.4）。 */
export const games = pgTable(
  "games",
  {
    hash: text("hash").primaryKey(),
    size: integer("size").notNull(),
    s3Key: text("s3_key").notNull(),
    analysis: jsonb("analysis").notNull(),
    themeId: text("theme_id").references(() => themes.id),
    verb: text("verb"),
    input: text("input"),
    durationFrames: integer("duration_frames"),
    thumbKey: text("thumb_key"),
    createdAt: createdAt(),
  },
  (t) => [
    // R-12.4-1: 180〜480。静的解析前は NULL でよい
    check(
      "games_duration_frames_range",
      sql`${t.durationFrames} IS NULL OR ${t.durationFrames} BETWEEN 180 AND 480`,
    ),
  ],
);

// ---- posts ----------------------------------------------------------------------

export const posts = pgTable(
  "posts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    gameHash: text("game_hash")
      .notNull()
      .references(() => games.hash),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    // spec#12.1 の `controls`。#26（gf:controls と gf:input の不一致）が決まるまで NULL 可
    controls: text("controls"),
    deterministic: boolean("deterministic").notNull().default(true),
    // I1: 挿入後は更新不可（トリガー posts_parent_id_immutable）。削除は RESTRICT（R-12.1-3）
    parentId: text("parent_id").references((): AnyPgColumn => posts.id, { onDelete: "restrict" }),
    treeId: text("tree_id").notNull(),
    depth: integer("depth").notNull().default(0),
    // 表示用 status はビュー post_status で導出する（R-12.1-5）
    baseStatus: baseStatus("base_status").notNull().default("pending"),
    indivRestricted: boolean("indiv_restricted").notNull().default(false),
    showcaseKey: text("showcase_key"),
    createdAt: createdAt(),
  },
  (t) => [
    index("posts_tree_depth_idx").on(t.treeId, t.depth),
    index("posts_user_status_idx").on(t.userId, t.baseStatus),
    index("posts_status_created_idx").on(t.baseStatus, t.createdAt),
    // I4: limited / public なら showcase_key が非 NULL
    check(
      "posts_showcase_key_when_visible",
      sql`${t.baseStatus} NOT IN ('limited', 'public') OR ${t.showcaseKey} IS NOT NULL`,
    ),
  ],
);

// ---- sessions ------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    userId: text("user_id").references(() => users.id),
    // seed は 32bit 符号なし（spec#7.1 の例 2891734521）なので bigint
    seed: bigint("seed", { mode: "number" }).notNull(),
    mode: sessionMode("mode").notNull(),
    state: sessionState("state").notNull().default("open"),
    score: integer("score"),
    frames: integer("frames"),
    logKey: text("log_key"),
    checkpoint: text("checkpoint"),
    verdict: verdict("verdict").notNull().default("provisional"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    index("sessions_rank_idx").on(t.postId, t.userId, t.verdict, t.score.desc()),
    // R-12.1-4: submitted_at は state = submitted のときだけ非 NULL
    check(
      "sessions_submitted_at_iff_submitted",
      sql`(${t.submittedAt} IS NOT NULL) = (${t.state} = 'submitted')`,
    ),
    // spec#10.4: 0 ≤ score
    check("sessions_score_nonnegative", sql`${t.score} IS NULL OR ${t.score} >= 0`),
  ],
);

// ---- reports -------------------------------------------------------------------

export const reports = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => users.id),
    category: text("category").notNull(),
    // spec#11.2: 性的・光過敏は 3、動作しないは 0.2 など小数を含む
    weight: doublePrecision("weight").notNull(),
    resolution: reportResolution("resolution").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reports_post_reporter_unique").on(t.postId, t.reporterId)],
);

// ---- moderation_actions（追記のみ） ------------------------------------------------

export const moderationActions = pgTable("moderation_actions", {
  id: serial("id").primaryKey(),
  actorId: text("actor_id")
    .notNull()
    .references(() => users.id),
  kind: moderationKind("kind").notNull(),
  postId: text("post_id").references(() => posts.id),
  userId: text("user_id").references(() => users.id),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});

// ---- fork_tokens ---------------------------------------------------------------

export const forkTokens = pgTable("fork_tokens", {
  token: text("token").primaryKey(),
  postId: text("post_id")
    .notNull()
    .references(() => posts.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

// ---- tree_locks ----------------------------------------------------------------

/** 有効なツリー制限の根。復帰は行の削除。action_id は監査行を必ず指す（I3 の DB 側） */
export const treeLocks = pgTable("tree_locks", {
  rootPostId: text("root_post_id")
    .primaryKey()
    .references(() => posts.id),
  actionId: integer("action_id")
    .notNull()
    .references(() => moderationActions.id),
  createdAt: createdAt(),
});

// ---- assets / post_assets -------------------------------------------------------

export const assets = pgTable("assets", {
  hash: text("hash").primaryKey(),
  type: assetType("type").notNull(),
  size: integer("size").notNull(),
  s3Key: text("s3_key").notNull(),
  source: assetSource("source").notNull(),
  uploaderId: text("uploader_id").references(() => users.id),
  scan: jsonb("scan").notNull(),
  createdAt: createdAt(),
});

export const postAssets = pgTable(
  "post_assets",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    name: text("name").notNull(),
    assetHash: text("asset_hash")
      .notNull()
      .references(() => assets.hash),
    required: boolean("required").notNull().default(false),
  },
  (t) => [primaryKey({ name: "post_assets_post_name_pk", columns: [t.postId, t.name] })],
);

// ---- runs（spec#12.4） -----------------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id),
    themeId: text("theme_id").references(() => themes.id),
    seed: bigint("seed", { mode: "number" }).notNull(),
    gameIds: text("game_ids").array().notNull(),
    results: text("results").array().notNull().default([]),
    cleared: integer("cleared").notNull().default(0),
    total: integer("total").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_theme_idx").on(t.themeId, t.startedAt),
    // R-12.4-2
    check("runs_cleared_le_total", sql`${t.cleared} >= 0 AND ${t.cleared} <= ${t.total}`),
    check("runs_results_le_total", sql`cardinality(${t.results}) <= ${t.total}`),
    check("runs_results_win_lose", sql`${t.results} <@ ARRAY['win', 'lose']::text[]`),
  ],
);

// ---- Better Auth / OAuth 2.1 認可サーバ（#5） ---------------------------------------------
// マイグレーション生成（drizzle-kit）がこのファイルを見るので、ここから再エクスポートする。
export * from "./auth-schema.ts";
