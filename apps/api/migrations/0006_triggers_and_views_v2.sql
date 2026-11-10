-- dm#A.5 の不変条件のうち CHECK / FK では書けないもの（トリガー）と、dm#A.4 の導出ビュー。
-- 手書き（drizzle-kit generate --custom）。#59

-- I1: parent_id は挿入後に変更できない（0001 のトリガーをそのまま使う。NULL ⇄ 値、値 → 別の値、いずれも拒否）
-- （posts_parent_id_immutable は 0001 で作成済み）

-- I5 + mo#A.2: base_status の遷移表。removed は終端、unpublished からは limited / public / removed、
-- draft には戻れない
CREATE FUNCTION posts_check_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_status = OLD.base_status THEN
    RETURN NEW;
  END IF;
  IF (OLD.base_status = 'draft'       AND NEW.base_status IN ('limited', 'public'))
  OR (OLD.base_status = 'limited'     AND NEW.base_status IN ('public', 'unpublished', 'removed'))
  OR (OLD.base_status = 'public'      AND NEW.base_status IN ('unpublished', 'removed'))
  OR (OLD.base_status = 'unpublished' AND NEW.base_status IN ('limited', 'public', 'removed'))
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'posts.base_status の遷移 % -> % は mo#A.2 にない（dm#A.5 I5）', OLD.base_status, NEW.base_status
    USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER posts_status_transition
  BEFORE UPDATE OF base_status ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_check_status_transition();--> statement-breakpoint

-- I10: game_hash / title / prompt は draft の間だけ更新できる（draft から出る同じ UPDATE での変更も認めない）
CREATE FUNCTION posts_reject_content_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.base_status <> 'draft'
     AND (NEW.game_hash IS DISTINCT FROM OLD.game_hash
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.prompt IS DISTINCT FROM OLD.prompt) THEN
    RAISE EXCEPTION 'posts の内容（game_hash / title / prompt）は draft の間だけ変更できる（dm#A.5 I10）: base_status=%', OLD.base_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER posts_content_only_in_draft
  BEFORE UPDATE OF game_hash, title, prompt ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_reject_content_update();--> statement-breakpoint

-- R-12.4-3: limited / public にする投稿の games.meta は verb / input / duration_frames / target を持つ
CREATE FUNCTION posts_require_game_meta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m jsonb;
BEGIN
  IF NEW.base_status IN ('limited', 'public') THEN
    SELECT meta INTO m FROM games WHERE hash = NEW.game_hash;
    IF m IS NULL OR NOT (m ? 'verb' AND m ? 'input' AND m ? 'duration_frames' AND m ? 'target') THEN
      RAISE EXCEPTION 'games.meta に verb / input / duration_frames / target が揃っていないゲームは limited / public にできない（dm#A.3）: game_hash=%', NEW.game_hash
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER posts_visible_requires_game_meta
  BEFORE INSERT OR UPDATE OF base_status, game_hash ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_require_game_meta();--> statement-breakpoint

-- I13: ended_at が入ったランの凍結値（reached / avg_deviation / symbols）は変わらない
CREATE FUNCTION runs_reject_frozen_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL
     AND (NEW.reached IS DISTINCT FROM OLD.reached
       OR NEW.avg_deviation IS DISTINCT FROM OLD.avg_deviation
       OR NEW.symbols IS DISTINCT FROM OLD.symbols
       OR NEW.ended IS DISTINCT FROM OLD.ended
       OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'runs の凍結値は ended_at の後に変更できない（dm#A.5 I13）: run_id=%', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER runs_frozen_after_end
  BEFORE UPDATE OF reached, avg_deviation, symbols, ended, ended_at ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_reject_frozen_update();--> statement-breakpoint

-- I17: actors.user_id は一度埋まったら変えられない
CREATE FUNCTION actors_reject_user_id_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'actors.user_id は一度埋まったら変更できない（dm#A.5 I17）: % -> %', OLD.user_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER actors_user_id_immutable
  BEFORE UPDATE OF user_id ON actors
  FOR EACH ROW EXECUTE FUNCTION actors_reject_user_id_change();--> statement-breakpoint

-- I14: 主体が匿名（actors.user_id が NULL）の通報は weight = 0 にする（受理時の検査を DB 側でも担保）
CREATE FUNCTION reports_anonymous_weight_zero() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  uid text;
BEGIN
  SELECT user_id INTO uid FROM actors WHERE id = NEW.actor_id;
  IF uid IS NULL THEN
    NEW.weight := 0;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER reports_anonymous_weight
  BEFORE INSERT ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_anonymous_weight_zero();--> statement-breakpoint

-- I12: miss_below が非 NULL なら、そのランは endless（run_id と is_new = false は CHECK）
CREATE FUNCTION sessions_check_miss_below_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m run_mode;
BEGIN
  IF NEW.miss_below IS NOT NULL AND NEW.run_id IS NOT NULL THEN
    SELECT mode INTO m FROM runs WHERE id = NEW.run_id;
    IF m IS DISTINCT FROM 'endless' THEN
      RAISE EXCEPTION 'sessions.miss_below は endless のランでだけ非 NULL（dm#A.5 I12）: run_id=%', NEW.run_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER sessions_miss_below_endless
  BEFORE INSERT OR UPDATE OF miss_below, run_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_check_miss_below_run();--> statement-breakpoint

-- dm#A.4 post_status: removed / unpublished / draft はそのまま、
-- indiv_restricted か祖先（自身を含む）が tree_locks の根なら restricted、それ以外は base_status
CREATE VIEW post_status AS
WITH RECURSIVE lineage AS (
  SELECT id, id AS ancestor, parent_id FROM posts
  UNION ALL
  SELECT l.id, p.id, p.parent_id
  FROM lineage l JOIN posts p ON p.id = l.parent_id
),
locked AS (
  SELECT DISTINCT l.id FROM lineage l JOIN tree_locks t ON t.root_post_id = l.ancestor
)
SELECT
  p.id,
  CASE
    WHEN p.base_status IN ('removed', 'unpublished', 'draft') THEN p.base_status::text
    WHEN p.indiv_restricted OR locked.id IS NOT NULL THEN 'restricted'
    ELSE p.base_status::text
  END AS status
FROM posts p LEFT JOIN locked ON locked.id = p.id;--> statement-breakpoint

-- dm#A.4 post_eligibility: ランに出せるか。normal / new / none
CREATE VIEW post_eligibility AS
SELECT
  p.id,
  CASE
    WHEN s.status = 'public' AND p.calibration = 'calibrated' THEN 'normal'
    WHEN s.status IN ('limited', 'public') AND p.calibration = 'uncalibrated' AND p.thumb_key IS NOT NULL THEN 'new'
    ELSE 'none'
  END AS eligibility
FROM posts p JOIN post_status s ON s.id = p.id;
