-- dm#A.5 I13（#157）: ended_at が入ったランには手番を足せない。
-- 記録に足す処理は runs の行ロックの中で ended_at を確かめる（I7）。これは別の経路からの挿入に対する最後の砦。
CREATE FUNCTION sessions_reject_closed_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  closed timestamptz;
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    SELECT ended_at INTO closed FROM runs WHERE id = NEW.run_id;
    IF closed IS NOT NULL THEN
      RAISE EXCEPTION '閉じたランに手番は足せない（dm#A.5 I13）: run_id=%', NEW.run_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER sessions_run_open
  BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_reject_closed_run();
