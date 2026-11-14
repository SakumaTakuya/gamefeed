ALTER TABLE "runs" ADD COLUMN "cursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cursor_nonnegative" CHECK ("runs"."cursor" >= 0);