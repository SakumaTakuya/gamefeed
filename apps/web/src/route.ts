// パスから画面を決める。ルーターのライブラリは、画面が増えてから入れる。

export type Route =
  | { page: "home" }
  | { page: "draft"; postId: string }
  /** ゲームページ。公開済みのゲームを 1 本だけ遊ぶ（run#A.14） */
  | { page: "game"; postId: string }
  /** エンドレスのスタート画面。fromRun があれば、そのランの山札で新しいランを作る（run#A.14） */
  | { page: "run"; fromRun: string | null };

/** 試遊 URL は `<app-origin>/draft/<post_id>`（mc#A.9）。 */
const DRAFT = /^\/draft\/([0-9A-HJKMNP-TV-Z]{26})\/?$/;
/** ゲームの共有リンクは `<app-origin>/g/<post_id>`（run#A.14、mc#A.9）。 */
const GAME = /^\/g\/([0-9A-HJKMNP-TV-Z]{26})\/?$/;
/** ランの共有リンクは `<app-origin>/r/<run_id>`（run#A.14）。 */
const SHARED_RUN = /^\/r\/([0-9A-HJKMNP-TV-Z]{26})\/?$/;

export function routeOf(pathname: string): Route {
  const draft = DRAFT.exec(pathname);
  if (draft?.[1]) return { page: "draft", postId: draft[1] };
  const game = GAME.exec(pathname);
  if (game?.[1]) return { page: "game", postId: game[1] };
  if (pathname === "/") return { page: "run", fromRun: null };
  const shared = SHARED_RUN.exec(pathname);
  if (shared?.[1]) return { page: "run", fromRun: shared[1] };
  return { page: "home" };
}
