-- run#A.3 / dm#A.3（#151、#156）: ランの計画を作成時に凍結する。
-- runs に game_hashes（位置ごとの内容）・miss_below（位置ごとの閾値）・seed（ランの seed）・settled（記録の長さ）を足し、
-- run_end に error（通信エラー。run#A.6）を足す。
-- 既存の行（#126〜#130 の古いモデルで作ったラン）は、今の posts.game_hash、閾値なし、seed 0、発行済みの手番数で埋める。
ALTER TYPE "public"."run_end" ADD VALUE 'error';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "game_hashes" text[];--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "miss_below" integer[];--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "seed" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "settled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "runs" r SET
  "game_hashes" = COALESCE((
    SELECT array_agg(p.game_hash ORDER BY d.ord)
    FROM unnest(r.deck) WITH ORDINALITY AS d(post_id, ord)
    LEFT JOIN posts p ON p.id = d.post_id), '{}'),
  "miss_below" = COALESCE((
    SELECT array_agg(NULL::integer)
    FROM unnest(r.deck) AS d(post_id)), '{}'),
  "seed" = 0,
  "settled" = (SELECT count(*) FROM sessions s WHERE s.run_id = r.id);--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "game_hashes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "miss_below" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "seed" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_plan_lengths" CHECK (cardinality("runs"."game_hashes") = cardinality("runs"."deck") AND cardinality("runs"."miss_below") = cardinality("runs"."deck") AND array_position("runs"."game_hashes", NULL) IS NULL);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_miss_below_nonnegative" CHECK (0 <= ALL("runs"."miss_below"));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_seed_u32" CHECK ("runs"."seed" BETWEEN 0 AND 4294967295);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_settled_nonnegative" CHECK ("runs"."settled" >= 0);
