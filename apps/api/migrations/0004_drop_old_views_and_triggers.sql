-- #59: dm#A.7 の追従。旧 12.1 / 12.4 のビューとトリガーを先に落とす（列や列挙型の変更がこれらに阻まれるため）。
-- 本番にデータは無い（Issue #59）。
DROP VIEW IF EXISTS run_results;--> statement-breakpoint
DROP VIEW IF EXISTS post_status;--> statement-breakpoint
DROP TRIGGER IF EXISTS posts_visible_requires_game_meta ON posts;--> statement-breakpoint
DROP FUNCTION IF EXISTS posts_require_game_meta();--> statement-breakpoint
DROP TRIGGER IF EXISTS posts_terminal_status ON posts;--> statement-breakpoint
DROP FUNCTION IF EXISTS posts_reject_terminal_transition();--> statement-breakpoint
-- 旧 sessions / runs / reports / moderation_actions の行は新スキーマに写せない（主体が actors に変わる）ので捨てる
TRUNCATE sessions, runs, reports, tree_locks, moderation_actions, fork_tokens, post_assets, posts, games, themes CASCADE;
