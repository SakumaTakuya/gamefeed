// ゲームページ（run#A.14、product#3 の 5）。公開済みのゲームを 1 本だけ遊ぶ。ランを経由しない。
// 配信するかどうかは配信オリジンが決める（se#A.5）。`GET /api/posts/{id}` は、見られない投稿をすぐ
// 「開けません」にすることと作者名のために読む。読めなくても遊ぶのは止めない。
import { useEffect, useState } from "react";
import { GameFrame } from "../game-frame.tsx";
import { gameUrl } from "../game-url.ts";
import { HOST_STAGE } from "../host-stage.ts";
import { useSinglePlayer } from "../single/use-single-player.ts";
import { fetchPost, type PostLookup } from "./api.ts";
import { gameView, STOPPED_TEXT, UNAVAILABLE_TEXT } from "./view.ts";

const GAMES_ORIGIN: string | undefined = import.meta.env.VITE_GAMES_ORIGIN;

export function GamePage({ postId }: { postId: string }) {
  if (!GAMES_ORIGIN) {
    return (
      <main style={styles.stage}>
        <p style={styles.note}>配信オリジン（VITE_GAMES_ORIGIN）が設定されていません。</p>
      </main>
    );
  }
  return <Player postId={postId} src={gameUrl(GAMES_ORIGIN, postId)} />;
}

function Player({ postId, src }: { postId: string; src: string }) {
  const { player, frameRef } = useSinglePlayer();
  // iframe の読み込みと並行して投稿を読む
  const [lookup, setLookup] = useState<PostLookup | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchPost(postId).then((r) => {
      if (alive) setLookup(r);
    });
    return () => {
      alive = false;
    };
  }, [postId]);

  const view = gameView({ state: player.state, meta: player.meta, halted: player.halted, lookup });
  const dead = view.kind === "unavailable" || view.kind === "stopped";

  return (
    <main style={styles.stage}>
      <div style={styles.frameBox}>
        {!dead && <GameFrame ref={frameRef} src={src} visible onLoad={player.frameLoaded} />}

        {/* Host の UI は iframe より上のレイヤに置く（se#A.3）。遊んでいる間は何もかぶせない */}
        {view.kind !== "playing" && (
          <div style={styles.overlay}>
            {view.kind === "loading" && <p>ゲームを読み込んでいます…</p>}

            {view.kind === "start" && (
              <button type="button" style={styles.start} onClick={player.start}>
                <span style={styles.verb}>{view.verb}</span>
                <span style={styles.title}>{view.title}</span>
                {view.author && <span style={styles.title}>@{view.author}</span>}
                <span>タップしてスタート</span>
              </button>
            )}

            {view.kind === "result" && (
              <>
                <p style={styles.verb}>{view.main}</p>
                {view.sub && <p>{view.sub}</p>}
                <button type="button" style={styles.button} onClick={player.again}>
                  もう一回
                </button>
              </>
            )}

            {view.kind === "unavailable" && <p>{UNAVAILABLE_TEXT}</p>}

            {view.kind === "stopped" && (
              <>
                <p>{STOPPED_TEXT}</p>
                <button type="button" style={styles.button} onClick={() => location.reload()}>
                  読み込み直す
                </button>
              </>
            )}

            {(view.kind === "result" || dead) && (
              <a href="/" style={styles.link}>
                ほかのゲームを続けて遊ぶ
              </a>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

const styles = {
  stage: {
    ...HOST_STAGE,
    position: "fixed",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "#000",
    color: "#fff",
    fontFamily: "system-ui, sans-serif",
  },
  note: { padding: "0 1.5rem", textAlign: "center", lineHeight: 1.7 },
  // 縦長 9:16 を基準に、画面に収まる最大の大きさ（gc#A.2）
  frameBox: {
    position: "relative",
    height: "min(100dvh, calc(100vw * 16 / 9))",
    aspectRatio: "9 / 16",
    background: "#111",
    overflow: "hidden",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1rem",
    padding: "1.5rem",
    textAlign: "center",
    color: "#fff",
    background: "rgba(0, 0, 0, 0.72)",
  },
  start: {
    all: "unset",
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1rem",
    cursor: "pointer",
    color: "#fff",
  },
  verb: { fontSize: "2.5rem", fontWeight: 700, margin: 0 },
  title: { fontSize: "1rem", opacity: 0.8 },
  button: {
    font: "inherit",
    padding: "0.7rem 1.4rem",
    borderRadius: "0.6rem",
    border: "1px solid #888",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
  },
  link: { color: "#fff", padding: "0.7rem", textDecoration: "underline" },
} satisfies Record<string, React.CSSProperties>;
