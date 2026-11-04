CREATE TYPE "public"."asset_source" AS ENUM('library', 'user');--> statement-breakpoint
CREATE TYPE "public"."asset_type" AS ENUM('image', 'sfx', 'bgm', 'model', 'font');--> statement-breakpoint
CREATE TYPE "public"."base_status" AS ENUM('pending', 'limited', 'public', 'removed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."moderation_kind" AS ENUM('restrict', 'restore', 'remove', 'restrict_tree', 'restore_tree', 'ban_user');--> statement-breakpoint
CREATE TYPE "public"."report_resolution" AS ENUM('open', 'upheld', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('play', 'replay');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('open', 'submitted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."theme_status" AS ENUM('draft', 'open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'post_restricted', 'banned');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('provisional', 'accepted', 'rejected', 'flagged');--> statement-breakpoint
CREATE TABLE "assets" (
	"hash" text PRIMARY KEY NOT NULL,
	"type" "asset_type" NOT NULL,
	"size" integer NOT NULL,
	"s3_key" text NOT NULL,
	"source" "asset_source" NOT NULL,
	"uploader_id" text,
	"scan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fork_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "games" (
	"hash" text PRIMARY KEY NOT NULL,
	"size" integer NOT NULL,
	"s3_key" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"theme_id" text,
	"verb" text,
	"input" text,
	"duration_frames" integer,
	"thumb_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_duration_frames_range" CHECK ("games"."duration_frames" IS NULL OR "games"."duration_frames" BETWEEN 180 AND 480)
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"kind" "moderation_kind" NOT NULL,
	"post_id" text,
	"user_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_assets" (
	"post_id" text NOT NULL,
	"name" text NOT NULL,
	"asset_hash" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	CONSTRAINT "post_assets_post_name_pk" PRIMARY KEY("post_id","name")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_hash" text NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"controls" text,
	"deterministic" boolean DEFAULT true NOT NULL,
	"parent_id" text,
	"tree_id" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"base_status" "base_status" DEFAULT 'pending' NOT NULL,
	"indiv_restricted" boolean DEFAULT false NOT NULL,
	"showcase_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_showcase_key_when_visible" CHECK ("posts"."base_status" NOT IN ('limited', 'public') OR "posts"."showcase_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"reporter_id" text NOT NULL,
	"category" text NOT NULL,
	"weight" double precision NOT NULL,
	"resolution" "report_resolution" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"theme_id" text,
	"seed" bigint NOT NULL,
	"game_ids" text[] NOT NULL,
	"results" text[] DEFAULT '{}' NOT NULL,
	"cleared" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "runs_cleared_le_total" CHECK ("runs"."cleared" >= 0 AND "runs"."cleared" <= "runs"."total"),
	CONSTRAINT "runs_results_le_total" CHECK (cardinality("runs"."results") <= "runs"."total"),
	CONSTRAINT "runs_results_win_lose" CHECK ("runs"."results" <@ ARRAY['win', 'lose']::text[])
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"user_id" text,
	"seed" bigint NOT NULL,
	"mode" "session_mode" NOT NULL,
	"state" "session_state" DEFAULT 'open' NOT NULL,
	"score" integer,
	"frames" integer,
	"log_key" text,
	"checkpoint" text,
	"verdict" "verdict" DEFAULT 'provisional' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "sessions_submitted_at_iff_submitted" CHECK (("sessions"."submitted_at" IS NOT NULL) = ("sessions"."state" = 'submitted')),
	CONSTRAINT "sessions_score_nonnegative" CHECK ("sessions"."score" IS NULL OR "sessions"."score" >= 0)
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"status" "theme_status" DEFAULT 'draft' NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tree_locks" (
	"root_post_id" text PRIMARY KEY NOT NULL,
	"action_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"trust_score" integer DEFAULT 10 NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_tokens" ADD CONSTRAINT "fork_tokens_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_tokens" ADD CONSTRAINT "fork_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_assets" ADD CONSTRAINT "post_assets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_assets" ADD CONSTRAINT "post_assets_asset_hash_assets_hash_fk" FOREIGN KEY ("asset_hash") REFERENCES "public"."assets"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_game_hash_games_hash_fk" FOREIGN KEY ("game_hash") REFERENCES "public"."games"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_id_posts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tree_locks" ADD CONSTRAINT "tree_locks_root_post_id_posts_id_fk" FOREIGN KEY ("root_post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tree_locks" ADD CONSTRAINT "tree_locks_action_id_moderation_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_tree_depth_idx" ON "posts" USING btree ("tree_id","depth");--> statement-breakpoint
CREATE INDEX "posts_user_status_idx" ON "posts" USING btree ("user_id","base_status");--> statement-breakpoint
CREATE INDEX "posts_status_created_idx" ON "posts" USING btree ("base_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_post_reporter_unique" ON "reports" USING btree ("post_id","reporter_id");--> statement-breakpoint
CREATE INDEX "runs_theme_idx" ON "runs" USING btree ("theme_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_rank_idx" ON "sessions" USING btree ("post_id","user_id","verdict","score" DESC NULLS LAST);