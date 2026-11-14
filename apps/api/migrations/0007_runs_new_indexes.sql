-- run#A.2 / dm#A.3（#123）: 新作扱いの位置は 1 個とは限らない（校正済みが足りない間は複数、未校正がなければ空）。
-- runs.new_index（int）を new_indexes（int[]）に変える。既存の行は 1 要素の配列に写す。
ALTER TABLE "runs" DROP CONSTRAINT "runs_new_index_in_deck";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "new_indexes" integer[];--> statement-breakpoint
UPDATE "runs" SET "new_indexes" = ARRAY["new_index"];--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "new_indexes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "new_index";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_new_indexes_in_deck" CHECK (array_position("runs"."new_indexes", NULL) IS NULL AND 0 <= ALL("runs"."new_indexes") AND cardinality("runs"."deck") > ALL("runs"."new_indexes"));
