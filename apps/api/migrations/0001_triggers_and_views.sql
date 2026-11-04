-- spec#12.2 の不変条件のうち CHECK / FK では書けないもの（トリガー）と、
-- spec#12.1 / 12.4 の導出ビュー。手書き（drizzle-kit generate --custom）。

-- I1: parent_id は挿入後に変更できない（NULL ⇄ 値、値 → 別の値、いずれも拒否）
CREATE FUNCTION posts_reject_parent_id_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'posts.parent_id は変更できない（spec#12.2 I1）: % -> %', OLD.parent_id, NEW.parent_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER posts_parent_id_immutable
  BEFORE UPDATE OF parent_id ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_reject_parent_id_update();--> statement-breakpoint

-- I5: removed / expired は終端。そこからの base_status 変更を拒否
CREATE FUNCTION posts_reject_terminal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.base_status IN ('removed', 'expired') AND NEW.base_status <> OLD.base_status THEN
    RAISE EXCEPTION 'posts.base_status は removed / expired から遷移できない（spec#12.2 I5）: % -> %', OLD.base_status, NEW.base_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER posts_terminal_status
  BEFORE UPDATE OF base_status ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_reject_terminal_transition();--> statement-breakpoint

-- R-12.4-3: limited / public にする投稿のゲームは verb・input が揃っている（静的解析済み）
CREATE FUNCTION posts_require_game_meta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g RECORD;
BEGIN
  IF NEW.base_status IN ('limited', 'public') THEN
    SELECT verb, input INTO g FROM games WHERE hash = NEW.game_hash;
    IF g.verb IS NULL OR g.input IS NULL THEN
      RAISE EXCEPTION 'games.verb / games.input が NULL のゲームは limited / public にできない（spec#12.4）: game_hash=%', NEW.game_hash
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER posts_visible_requires_game_meta
  BEFORE INSERT OR UPDATE OF base_status, game_hash ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_require_game_meta();--> statement-breakpoint

-- R-12.1-5: 表示用 status。removed / expired / pending はそのまま、
-- 個別制限か、祖先（自身を含む）が tree_locks の根なら restricted、それ以外は base_status
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
    WHEN p.base_status IN ('removed', 'expired', 'pending') THEN p.base_status::text
    WHEN p.indiv_restricted OR locked.id IS NOT NULL THEN 'restricted'
    ELSE p.base_status::text
  END AS status
FROM posts p LEFT JOIN locked ON locked.id = p.id;--> statement-breakpoint

-- R-12.4-4: お題ごとのクリア率（Σcleared / Σtotal）と完走率（ended_at 非 NULL の割合）
CREATE VIEW run_results AS
SELECT
  theme_id,
  count(*) AS runs,
  sum(cleared)::double precision / nullif(sum(total), 0) AS clear_rate,
  count(ended_at)::double precision / count(*) AS completion_rate
FROM runs
WHERE theme_id IS NOT NULL
GROUP BY theme_id;
