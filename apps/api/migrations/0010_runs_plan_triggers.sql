-- dm#A.5 I13（#156）: ランの計画（deck / new_indexes / game_hashes / miss_below / seed）は挿入後に変わらない。
-- 同じ値の書き戻しは通す（IS DISTINCT FROM。配列は要素ごとに比べ、NULL 同士は同じとみなす）
CREATE FUNCTION runs_reject_plan_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deck IS DISTINCT FROM OLD.deck
     OR NEW.new_indexes IS DISTINCT FROM OLD.new_indexes
     OR NEW.game_hashes IS DISTINCT FROM OLD.game_hashes
     OR NEW.miss_below IS DISTINCT FROM OLD.miss_below
     OR NEW.seed IS DISTINCT FROM OLD.seed THEN
    RAISE EXCEPTION 'runs の計画は挿入後に変更できない（dm#A.5 I13）: run_id=%', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER runs_plan_immutable
  BEFORE UPDATE OF deck, new_indexes, game_hashes, miss_below, seed ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_reject_plan_change();--> statement-breakpoint

-- I13: ended_at が入ったランは settled（記録の長さ）も変わらない。閉じる更新そのもの（OLD.ended_at が NULL）は通る
CREATE OR REPLACE FUNCTION runs_reject_frozen_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL
     AND (NEW.reached IS DISTINCT FROM OLD.reached
       OR NEW.avg_deviation IS DISTINCT FROM OLD.avg_deviation
       OR NEW.symbols IS DISTINCT FROM OLD.symbols
       OR NEW.ended IS DISTINCT FROM OLD.ended
       OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR NEW.settled IS DISTINCT FROM OLD.settled) THEN
    RAISE EXCEPTION 'runs の凍結値は ended_at の後に変更できない（dm#A.5 I13）: run_id=%', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER runs_frozen_after_end ON runs;--> statement-breakpoint
CREATE TRIGGER runs_frozen_after_end
  BEFORE UPDATE OF reached, avg_deviation, symbols, ended, ended_at, settled ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_reject_frozen_update();
