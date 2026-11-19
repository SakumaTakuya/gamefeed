-- run#A.3 / sc#A.2 / dm#A.3（#151、#162、#157）: 結果を記録に手番の順に足す。
-- session_via に noload（読み込みの skip）を足す。frames は 0 を通す（開始直後に終わった結果も遊んだ結果）。
-- post_stats に failures（満了と error の件数。sc#A.4）を足す。runs.cursor は next と一緒に無くなる。
-- 古いモデル（#126〜#130）で入った手番の行（open / skipped / abandoned、timeout の score 0）は直さない。
-- 本番には無い（0007 以降をまだ当てていない）。
ALTER TYPE "public"."session_via" ADD VALUE 'noload';--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_cursor_nonnegative";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_frames_range";--> statement-breakpoint
ALTER TABLE "post_stats" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "cursor";--> statement-breakpoint
ALTER TABLE "post_stats" ADD CONSTRAINT "post_stats_failures_nonnegative" CHECK ("post_stats"."failures" >= 0);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_frames_range" CHECK ("sessions"."frames" IS NULL OR ("sessions"."frames" >= 0 AND "sessions"."frames" <= "sessions"."time_limit"));