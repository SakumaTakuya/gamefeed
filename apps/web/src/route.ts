// パスから画面を決める。ルーターのライブラリは、画面が増えてから入れる。

export type Route = { page: "home" } | { page: "draft"; postId: string };

/** 試遊 URL は `<app-origin>/draft/<post_id>`（mc#A.9）。 */
const DRAFT = /^\/draft\/([0-9A-HJKMNP-TV-Z]{26})\/?$/;

export function routeOf(pathname: string): Route {
  const draft = DRAFT.exec(pathname);
  if (draft?.[1]) return { page: "draft", postId: draft[1] };
  return { page: "home" };
}
