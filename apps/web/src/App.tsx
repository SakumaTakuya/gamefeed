// 画面は 4 種だけ（お題一覧、ラン、ラン結果、投稿の試遊）＋運営画面。CLAUDE.md 参照。
// ラン再生は domain の状態機械を呼ぶだけの薄い殻にする。
import { DraftPage } from "./draft/DraftPage.tsx";
import { GamePage } from "./game/GamePage.tsx";
import { RestorePage } from "./mod/RestorePage.tsx";
import { routeOf } from "./route.ts";
import { RunPage } from "./run/RunPage.tsx";

export function App() {
  const route = routeOf(location.pathname);
  if (route.page === "draft") return <DraftPage postId={route.postId} />;
  if (route.page === "game") return <GamePage postId={route.postId} />;
  if (route.page === "restore") return <RestorePage postId={route.postId} />;
  if (route.page === "run") return <RunPage fromRun={route.fromRun} />;
  return <main>GameFeed</main>;
}
