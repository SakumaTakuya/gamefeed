// ハーネスのページ `/harness/<post_id>`（scoring.md A.10）。公開直後のジョブが headless Chromium で開く。
// 本番と同じ Host（`createHost`）と同じ iframe の属性（`GameFrame`）でゲームを読み込み、入力なしで 1 回遊ばせて、
// 結果を `data-harness` に出す。誰でも開けるが、サーバには何も送らない。ハーネス専用の緩和は持たない。
import { isSpeed, type Speed } from "@gamefeed/domain";
import { useEffect } from "react";
import { GameFrame } from "../game-frame.tsx";
import { gameUrl } from "../game-url.ts";
import { useSinglePlayer } from "../single/use-single-player.ts";
import { harnessReport, harnessSpeed } from "./report.ts";

const GAMES_ORIGIN: string | undefined = import.meta.env.VITE_GAMES_ORIGIN;

export function HarnessPage({ postId }: { postId: string }) {
  if (!GAMES_ORIGIN) return <main data-harness-error="no_games_origin" />;
  return <Harness src={gameUrl(GAMES_ORIGIN, postId)} />;
}

function Harness({ src }: { src: string }) {
  const speed = harnessSpeed(location.search, isSpeed) as Speed;
  const { player, frameRef } = useSinglePlayer(speed);
  const kind = player.state.kind;
  // 準備ができたら、タップを待たずに始める
  useEffect(() => {
    if (kind === "INITED") player.start();
  }, [kind, player]);
  const report = harnessReport(player);
  return (
    <main
      data-harness={JSON.stringify(report)}
      style={{ position: "fixed", inset: 0, background: "#000" }}
    >
      {report.phase !== "done" || report.outcome === "ended" ? (
        <GameFrame ref={frameRef} src={src} visible onLoad={player.frameLoaded} />
      ) : null}
    </main>
  );
}
