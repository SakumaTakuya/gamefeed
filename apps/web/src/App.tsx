// 画面は 4 種だけ（お題一覧、ラン、ラン結果、投稿の試遊）＋運営画面。CLAUDE.md 参照。
// ラン再生は domain の状態機械を呼ぶだけの薄い殻にする。
import { DraftPage } from "./draft/DraftPage.tsx";
import { routeOf } from "./route.ts";

export function App() {
  const route = routeOf(location.pathname);
  if (route.page === "draft") return <DraftPage postId={route.postId} />;
  return <main>GameFeed</main>;
}
