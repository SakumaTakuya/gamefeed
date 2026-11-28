// 画面は 4 種だけ（お題一覧、ラン、ラン結果、投稿の試遊）＋運営画面。CLAUDE.md 参照。
// ラン再生は domain の状態機械を呼ぶだけの薄い殻にする。
import { lazy, Suspense } from "react";
import { DraftPage } from "./draft/DraftPage.tsx";
import { GamePage } from "./game/GamePage.tsx";
import { HarnessPage } from "./harness/HarnessPage.tsx";
import { RestorePage } from "./mod/RestorePage.tsx";
import { routeOf } from "./route.ts";
import { RunPage } from "./run/RunPage.tsx";

// Host の層の見本（開発サーバだけ。本番の束には入らない）
const HostSamples = import.meta.env.DEV
  ? lazy(() => import("./dev/HostSamples.tsx").then((m) => ({ default: m.HostSamples })))
  : null;

export function App() {
  if (HostSamples && location.pathname === "/dev/host") {
    return (
      <Suspense fallback={null}>
        <HostSamples />
      </Suspense>
    );
  }
  const route = routeOf(location.pathname);
  if (route.page === "draft") return <DraftPage postId={route.postId} />;
  if (route.page === "game") return <GamePage postId={route.postId} />;
  if (route.page === "restore") return <RestorePage postId={route.postId} />;
  if (route.page === "harness") return <HarnessPage postId={route.postId} />;
  if (route.page === "run") return <RunPage fromRun={route.fromRun} />;
  return <main>GameFeed</main>;
}
