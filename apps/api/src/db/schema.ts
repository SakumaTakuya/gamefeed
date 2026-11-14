/**
 * データモデル（`docs/data-model.md` A.2 列挙型、A.3 テーブル、A.5 不変条件のうち DB で担保するもの）。
 *
 * ここに書けるのは列・型・UNIQUE・FK・CHECK・索引まで。トリガーとビューは
 * `migrations/` の custom マイグレーション（`drizzle-kit generate --custom`）に SQL で書く。
 * 列挙型の値の順序は dm#A.2 の記載順（R-12.1-1）。
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---- 列挙型（dm#A.2） ----------------------------------------------------------

export const userStatus = pgEnum("user_status", ["active", "post_restricted", "banned"]);
export const baseStatus = pgEnum("base_status", [
  "draft",
  "limited",
  "public",
  "unpublished",
  "removed",
]);
export const calibration = pgEnum("calibration", [
  "uncalibrated",
  "calibrated",
  "review",
  "invalid",
]);
export const sessionState = pgEnum("session_state", ["open", "submitted", "skipped", "abandoned"]);
export const sessionMode = pgEnum("session_mode", ["play", "replay"]);
export const sessionVia = pgEnum("session_via", ["guest", "timeout", "error"]);
export const verdict = pgEnum("verdict", ["provisional", "accepted", "rejected", "flagged"]);
export const runMode = pgEnum("run_mode", ["endless", "daily"]);
export const runEnd = pgEnum("run_end", ["lives", "limit", "abandoned"]);
export const reportResolution = pgEnum("report_resolution", ["open", "upheld", "dismissed"]);
export const moderationKind = pgEnum("moderation_kind", [
  "restrict",
  "restore",
  "remove",
  "restrict_tree",
  "restore_tree",
  "ban_user",
  "unban_user",
  "calibration_confirm",
  "calibration_invalidate",
]);
export const deviceKind = pgEnum("device_kind", ["ios", "android", "other"]);
export const assetType = pgEnum("asset_type", ["image", "sfx", "model", "font"]);
export const assetSource = pgEnum("asset_source", ["library", "user"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---- users（作る側） --------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(),
  trustScore: integer("trust_score").notNull().default(10),
  status: userStatus("status").notNull().default("active"),
  createdAt: createdAt(),
});

// ---- actors（遊ぶ側の主体。匿名を含む。dm#A.1、B.3） ----------------------------------------

/** `device_id` ごとに 1 行。ログインすると `user_id` が埋まり、以後変えない（I17。トリガー） */
export const actors = pgTable("actors", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().unique(),
  userId: text("user_id").references(() => users.id),
  createdAt: createdAt(),
});

// ---- themes / theme_posts（デイリーのお題。dm#A.3、B.8） ------------------------------------

export const themes = pgTable(
  "themes",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [check("themes_status_values", sql`${t.status} IN ('draft', 'open', 'closed')`)],
);

// ---- games（内容。不変） ---------------------------------------------------------------

/**
 * HTML 本体はハッシュで重複排除。内容から決まるもの（title / verb / input / duration_frames / target /
 * deterministic / warnings）は静的検査の結果として `meta` に入る（dm#B.1）。
 */
export const games = pgTable(
  "games",
  {
    hash: text("hash").primaryKey(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    /** R2 への書き込みが成功した時刻。NULL の間は配信しない（mc#A.6） */
    storedAt: timestamp("stored_at", { withTimezone: true }),
    meta: jsonb("meta").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("games_size_max", sql`${t.size} >= 0 AND ${t.size} <= 131072`)],
);

// ---- posts（投稿） ------------------------------------------------------------------

export const posts = pgTable(
  "posts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // I10: draft の間だけ更新可（トリガー posts_content_only_in_draft）
    gameHash: text("game_hash")
      .notNull()
      .references(() => games.hash),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    // I1: 挿入後は更新不可（トリガー posts_parent_id_immutable）。削除は RESTRICT（R-12.1-3）
    parentId: text("parent_id").references((): AnyPgColumn => posts.id, { onDelete: "restrict" }),
    treeId: text("tree_id").notNull(),
    depth: integer("depth").notNull().default(0),
    // 表示用 status はビュー post_status で導出する（R-12.1-5）
    baseStatus: baseStatus("base_status").notNull().default("draft"),
    indivRestricted: boolean("indiv_restricted").notNull().default(false),
    calibration: calibration("calibration").notNull().default("uncalibrated"),
    calibrationFlags: jsonb("calibration_flags").notNull().default({}),
    /** 公開直後のジョブが入れる。できるまで新作枠に入らない（mc#A.9） */
    thumbKey: text("thumb_key"),
    previewKey: text("preview_key"),
    /** draft から出た時刻（I4） */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** 下書きの自動削除の基準（I11） */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("posts_tree_depth_idx").on(t.treeId, t.depth),
    index("posts_user_status_idx").on(t.userId, t.baseStatus),
    index("posts_status_calibration_idx").on(t.baseStatus, t.calibration),
    index("posts_user_status_updated_idx").on(t.userId, t.baseStatus, t.updatedAt),
    // I4: limited / public / unpublished なら published_at が非 NULL
    check(
      "posts_published_at_when_published",
      sql`${t.baseStatus} NOT IN ('limited', 'public', 'unpublished') OR ${t.publishedAt} IS NOT NULL`,
    ),
    check("posts_depth_nonnegative", sql`${t.depth} >= 0`),
  ],
);

// ---- sessions（1 手番 = 1 行） ----------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    // 行が消えるのは draft だけなので、消えるセッションは試遊のもの（mo#B.6）
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    /** 発行時の posts.game_hash を写す（dm#B.4） */
    gameHash: text("game_hash")
      .notNull()
      .references(() => games.hash),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    deviceKind: deviceKind("device_kind").notNull(),
    runId: text("run_id").references((): AnyPgColumn => runs.id),
    turn: integer("turn"),
    mode: sessionMode("mode").notNull(),
    // seed は 32bit 符号なし（protocol#A.3 の例 2891734521）なので bigint
    seed: bigint("seed", { mode: "number" }).notNull(),
    speed: numeric("speed", { precision: 4, scale: 3 }).notNull(),
    /** 発行時の meta.duration_frames */
    timeLimit: integer("time_limit").notNull(),
    /** 発行時に凍結（sc#A.6）。校正前・新作枠・デイリー・試遊は NULL */
    missBelow: integer("miss_below"),
    isNew: boolean("is_new").notNull().default(false),
    /** 投稿者本人のセッション。分布に入れない */
    author: boolean("author").notNull().default(false),
    state: sessionState("state").notNull().default("open"),
    via: sessionVia("via"),
    score: integer("score"),
    frames: integer("frames"),
    logKey: text("log_key"),
    verdict: verdict("verdict").notNull().default("provisional"),
    deviation: numeric("deviation", { precision: 4, scale: 1 }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    index("sessions_distribution_idx").on(t.postId, t.speed, t.author, t.verdict, t.score),
    uniqueIndex("sessions_run_turn_unique").on(t.runId, t.turn),
    index("sessions_actor_post_submitted_idx").on(t.actorId, t.postId, t.submittedAt),
    // R-12.1-4: submitted_at と via は state = submitted のときだけ非 NULL
    check(
      "sessions_submitted_at_iff_submitted",
      sql`(${t.submittedAt} IS NOT NULL) = (${t.state} = 'submitted')`,
    ),
    check("sessions_via_iff_submitted", sql`(${t.via} IS NOT NULL) = (${t.state} = 'submitted')`),
    // gc#A.4: 0 ≤ score ≤ 2^31−1（integer の上限）
    check("sessions_score_nonnegative", sql`${t.score} IS NULL OR ${t.score} >= 0`),
    // sc#A.2: 1 ≤ frames ≤ time_limit
    check(
      "sessions_frames_range",
      sql`${t.frames} IS NULL OR (${t.frames} >= 1 AND ${t.frames} <= ${t.timeLimit})`,
    ),
    check("sessions_time_limit_positive", sql`${t.timeLimit} >= 1`),
    // I12: speed は 5 値のどれか（run#A.8）
    check("sessions_speed_values", sql`${t.speed} IN (1.000, 1.125, 1.250, 1.375, 1.500)`),
    // I12: miss_below が非 NULL なら run_id が非 NULL かつ is_new = false（endless かはトリガー sessions_miss_below_endless）
    check(
      "sessions_miss_below_requires_run",
      sql`${t.missBelow} IS NULL OR (${t.runId} IS NOT NULL AND ${t.isNew} = false)`,
    ),
    check("sessions_turn_iff_run", sql`(${t.turn} IS NOT NULL) = (${t.runId} IS NOT NULL)`),
    check("sessions_turn_nonnegative", sql`${t.turn} IS NULL OR ${t.turn} >= 0`),
  ],
);

// ---- runs（ラン。凍結値を持つ。dm#B.2） ---------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    mode: runMode("mode").notNull(),
    themeId: text("theme_id").references(() => themes.id),
    date: date("date"),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    /** 山札の post_id（エンドレスは 1〜12、デイリーは 10）。予定。実行済みの手番は sessions(run_id, turn) が正 */
    deck: text("deck").array().notNull(),
    /** 山札の中で新作扱い（is_new）にする位置。通常 1 個、校正済みが足りない間は複数、未校正がなければ空（run#A.2、#123） */
    newIndexes: integer("new_indexes").array().notNull(),
    fromRun: text("from_run").references((): AnyPgColumn => runs.id),
    lives: integer("lives").notNull(),
    // 凍結値（I13。ended_at が入った後は変えられない。トリガー runs_frozen_after_end）
    reached: integer("reached"),
    avgDeviation: numeric("avg_deviation", { precision: 4, scale: 1 }),
    symbols: text("symbols"),
    ended: runEnd("ended"),
    recorded: boolean("recorded").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_actor_started_idx").on(t.actorId, t.startedAt),
    // I16: 同じ主体・お題・日付で recorded = true のランは 1 本
    uniqueIndex("runs_recorded_unique").on(t.themeId, t.date, t.actorId).where(sql`${t.recorded}`),
    // run#A.2: デイリーは theme_id と date を持ち、エンドレスは持たない
    check(
      "runs_daily_fields",
      sql`(${t.mode} = 'daily') = (${t.themeId} IS NOT NULL AND ${t.date} IS NOT NULL)`,
    ),
    check("runs_lives_nonnegative", sql`${t.lives} >= 0`),
    check(
      "runs_new_indexes_in_deck",
      // 配列に NULL があると ALL の比較が UNKNOWN になり CHECK を通るので、NULL の要素も拒否する
      sql`array_position(${t.newIndexes}, NULL) IS NULL AND 0 <= ALL(${t.newIndexes}) AND cardinality(${t.deck}) > ALL(${t.newIndexes})`,
    ),
    check("runs_ended_iff_ended_at", sql`(${t.ended} IS NOT NULL) = (${t.endedAt} IS NOT NULL)`),
  ],
);

// ---- theme_posts（お題の 10 本） -----------------------------------------------------------

export const themePosts = pgTable(
  "theme_posts",
  {
    themeId: text("theme_id")
      .notNull()
      .references(() => themes.id),
    position: integer("position").notNull(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
  },
  (t) => [
    primaryKey({ name: "theme_posts_theme_position_pk", columns: [t.themeId, t.position] }),
    uniqueIndex("theme_posts_theme_post_unique").on(t.themeId, t.postId),
    // I12: position は 0〜9
    check("theme_posts_position_range", sql`${t.position} >= 0 AND ${t.position} <= 9`),
  ],
);

// ---- likes / reports（主体は actor） -----------------------------------------------------

export const likes = pgTable(
  "likes",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: "likes_post_actor_pk", columns: [t.postId, t.actorId] })],
);

export const reports = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    category: text("category").notNull(),
    // mo#A.5: 重みは小数を含む。匿名の主体は受理時に 0（I14。トリガー reports_anonymous_weight_zero）
    weight: doublePrecision("weight").notNull(),
    resolution: reportResolution("resolution").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reports_post_actor_unique").on(t.postId, t.actorId),
    check("reports_weight_nonnegative", sql`${t.weight} >= 0`),
  ],
);

// ---- moderation_actions（追記のみ）/ tree_locks ------------------------------------------------

export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: serial("id").primaryKey(),
    /** 運営。NULL は自動制限（mo#A.4） */
    moderatorId: text("moderator_id").references(() => users.id),
    kind: moderationKind("kind").notNull(),
    postId: text("post_id").references(() => posts.id),
    userId: text("user_id").references(() => users.id),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // restrict / restore は post_id と user_id のどちらか一方
    check(
      "moderation_actions_restrict_target",
      sql`${t.kind} NOT IN ('restrict', 'restore') OR ((${t.postId} IS NOT NULL) <> (${t.userId} IS NOT NULL))`,
    ),
  ],
);

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

// ---- post_stats（派生。分布のキャッシュ。dm#B.5） ---------------------------------------------

export const postStats = pgTable(
  "post_stats",
  {
    postId: text("post_id")
      .primaryKey()
      .references(() => posts.id),
    n: integer("n").notNull().default(0),
    /** 昇順。上限 10,000 件（暫定） */
    scores: integer("scores").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("post_stats_n_matches_scores", sql`${t.n} = cardinality(${t.scores})`)],
);

// ---- Phase 2（定義だけ先に置く） ------------------------------------------------------------

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

export const assets = pgTable("assets", {
  hash: text("hash").primaryKey(),
  type: assetType("type").notNull(),
  size: integer("size").notNull(),
  r2Key: text("r2_key").notNull(),
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

// ---- Better Auth / OAuth 2.1 認可サーバ（#5） ---------------------------------------------
// マイグレーション生成（drizzle-kit）がこのファイルを見るので、ここから再エクスポートする。
export * from "./auth-schema.ts";
