CREATE TYPE "public"."calibration" AS ENUM('uncalibrated', 'calibrated', 'review', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('ios', 'android', 'other');--> statement-breakpoint
CREATE TYPE "public"."run_end" AS ENUM('lives', 'limit', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."run_mode" AS ENUM('endless', 'daily');--> statement-breakpoint
CREATE TYPE "public"."session_via" AS ENUM('guest', 'timeout', 'error');--> statement-breakpoint
ALTER TYPE "public"."moderation_kind" ADD VALUE 'unban_user';--> statement-breakpoint
ALTER TYPE "public"."moderation_kind" ADD VALUE 'calibration_confirm';--> statement-breakpoint
ALTER TYPE "public"."moderation_kind" ADD VALUE 'calibration_invalidate';--> statement-breakpoint
ALTER TYPE "public"."session_state" ADD VALUE 'skipped' BEFORE 'abandoned';--> statement-breakpoint
CREATE TABLE "actors" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"post_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_post_actor_pk" PRIMARY KEY("post_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "post_stats" (
	"post_id" text PRIMARY KEY NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"scores" integer[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_stats_n_matches_scores" CHECK ("post_stats"."n" = cardinality("post_stats"."scores"))
);
--> statement-breakpoint
CREATE TABLE "theme_posts" (
	"theme_id" text NOT NULL,
	"position" integer NOT NULL,
	"post_id" text NOT NULL,
	CONSTRAINT "theme_posts_theme_position_pk" PRIMARY KEY("theme_id","position"),
	CONSTRAINT "theme_posts_position_range" CHECK ("theme_posts"."position" >= 0 AND "theme_posts"."position" <= 9)
);
--> statement-breakpoint
ALTER TABLE "games" DROP CONSTRAINT "games_duration_frames_range";--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_showcase_key_when_visible";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_cleared_le_total";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_results_le_total";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_results_win_lose";--> statement-breakpoint
ALTER TABLE "games" DROP CONSTRAINT "games_theme_id_themes_id_fk";
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_actor_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_reporter_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_post_id_posts_id_fk";
--> statement-breakpoint
ALTER TABLE "themes" DROP CONSTRAINT "themes_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."asset_type";--> statement-breakpoint
CREATE TYPE "public"."asset_type" AS ENUM('image', 'sfx', 'model', 'font');--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "type" SET DATA TYPE "public"."asset_type" USING "type"::"public"."asset_type";--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "base_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "base_status" SET DEFAULT 'draft'::text;--> statement-breakpoint
DROP TYPE "public"."base_status";--> statement-breakpoint
CREATE TYPE "public"."base_status" AS ENUM('draft', 'limited', 'public', 'unpublished', 'removed');--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "base_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "base_status" SET DATA TYPE "public"."base_status" USING "base_status"::"public"."base_status";--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "base_status" SET DEFAULT 'draft'::"public"."base_status";--> statement-breakpoint
DROP INDEX "posts_status_created_idx";--> statement-breakpoint
DROP INDEX "reports_post_reporter_unique";--> statement-breakpoint
DROP INDEX "runs_theme_idx";--> statement-breakpoint
DROP INDEX "sessions_rank_idx";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "themes" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "themes" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "r2_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "r2_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "stored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "meta" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "moderator_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "calibration" "calibration" DEFAULT 'uncalibrated' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "calibration_flags" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "thumb_key" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "preview_key" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "actor_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mode" "run_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "date" date;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "actor_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "deck" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "new_index" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "from_run" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lives" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reached" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "avg_deviation" numeric(4, 1);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "symbols" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ended" "run_end";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "recorded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "game_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "actor_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_kind" "device_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "speed" numeric(4, 3) NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "time_limit" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "miss_below" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "is_new" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "author" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "via" "session_via";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "deviation" numeric(4, 1);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "issued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "themes" ADD COLUMN "slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_stats" ADD CONSTRAINT "post_stats_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_posts" ADD CONSTRAINT "theme_posts_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_posts" ADD CONSTRAINT "theme_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "theme_posts_theme_post_unique" ON "theme_posts" USING btree ("theme_id","post_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_from_run_runs_id_fk" FOREIGN KEY ("from_run") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_game_hash_games_hash_fk" FOREIGN KEY ("game_hash") REFERENCES "public"."games"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_status_calibration_idx" ON "posts" USING btree ("base_status","calibration");--> statement-breakpoint
CREATE INDEX "posts_user_status_updated_idx" ON "posts" USING btree ("user_id","base_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_post_actor_unique" ON "reports" USING btree ("post_id","actor_id");--> statement-breakpoint
CREATE INDEX "runs_actor_started_idx" ON "runs" USING btree ("actor_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_recorded_unique" ON "runs" USING btree ("theme_id","date","actor_id") WHERE "runs"."recorded";--> statement-breakpoint
CREATE INDEX "sessions_distribution_idx" ON "sessions" USING btree ("post_id","speed","author","verdict","score");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_run_turn_unique" ON "sessions" USING btree ("run_id","turn");--> statement-breakpoint
CREATE INDEX "sessions_actor_post_submitted_idx" ON "sessions" USING btree ("actor_id","post_id","submitted_at");--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "s3_key";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "s3_key";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "analysis";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "theme_id";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "verb";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "input";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "duration_frames";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "thumb_key";--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP COLUMN "actor_id";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "controls";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "deterministic";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "showcase_key";--> statement-breakpoint
ALTER TABLE "reports" DROP COLUMN "reporter_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "seed";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "game_ids";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "results";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "cleared";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "total";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "checkpoint";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "opened_at";--> statement-breakpoint
ALTER TABLE "themes" DROP COLUMN "prompt";--> statement-breakpoint
ALTER TABLE "themes" DROP COLUMN "opens_at";--> statement-breakpoint
ALTER TABLE "themes" DROP COLUMN "closes_at";--> statement-breakpoint
ALTER TABLE "themes" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_slug_unique" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_size_max" CHECK ("games"."size" >= 0 AND "games"."size" <= 131072);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_restrict_target" CHECK ("moderation_actions"."kind" NOT IN ('restrict', 'restore') OR (("moderation_actions"."post_id" IS NOT NULL) <> ("moderation_actions"."user_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_published_at_when_published" CHECK ("posts"."base_status" NOT IN ('limited', 'public', 'unpublished') OR "posts"."published_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_depth_nonnegative" CHECK ("posts"."depth" >= 0);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_weight_nonnegative" CHECK ("reports"."weight" >= 0);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_daily_fields" CHECK (("runs"."mode" = 'daily') = ("runs"."theme_id" IS NOT NULL AND "runs"."date" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_lives_nonnegative" CHECK ("runs"."lives" >= 0);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_new_index_in_deck" CHECK ("runs"."new_index" >= 0 AND "runs"."new_index" < cardinality("runs"."deck"));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ended_iff_ended_at" CHECK (("runs"."ended" IS NOT NULL) = ("runs"."ended_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_via_iff_submitted" CHECK (("sessions"."via" IS NOT NULL) = ("sessions"."state" = 'submitted'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_frames_range" CHECK ("sessions"."frames" IS NULL OR ("sessions"."frames" >= 1 AND "sessions"."frames" <= "sessions"."time_limit"));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_time_limit_positive" CHECK ("sessions"."time_limit" >= 1);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_speed_values" CHECK ("sessions"."speed" IN (1.000, 1.125, 1.250, 1.375, 1.500));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_miss_below_requires_run" CHECK ("sessions"."miss_below" IS NULL OR ("sessions"."run_id" IS NOT NULL AND "sessions"."is_new" = false));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_turn_iff_run" CHECK (("sessions"."turn" IS NOT NULL) = ("sessions"."run_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_turn_nonnegative" CHECK ("sessions"."turn" IS NULL OR "sessions"."turn" >= 0);--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_status_values" CHECK ("themes"."status" IN ('draft', 'open', 'closed'));--> statement-breakpoint
DROP TYPE "public"."theme_status";