// ゲームページ（run#A.14、product#3 の 5）。公開済みのゲームを 1 本だけ遊ぶ。ランを経由しない。
// 配信するかどうかは配信オリジンが決める（se#A.5）。`GET /api/posts/{id}` は、見られない投稿をすぐ
// 「開けません」にすることと作者名・いいね・プレイ数のために読む。読めなくても遊ぶのは止めない。
// 校正済みのゲームは、結果の点数の「今の偏差値」も読む（product#5.3）。
import type { ReportCategory } from "@gamefeed/domain";
import { useEffect, useState } from "react";
import { GameFrame } from "../game-frame.tsx";
import { gameUrl } from "../game-url.ts";
import { HOST_STAGE } from "../host-stage.ts";
import { deviceId } from "../run/device-id.ts";
import { useSinglePlayer } from "../single/use-single-player.ts";
import { fetchDeviation, fetchPost, type PostLookup, type PostStats, sendLike } from "./api.ts";
import { REPORT_OPTIONS, type ReportResult, reportDraft, sendReport } from "./report.ts";
import { gameView, STOPPED_TEXT, UNAVAILABLE_TEXT } from "./view.ts";

const GAMES_ORIGIN: string | undefined = import.meta.env.VITE_GAMES_ORIGIN;

/** 端末の主体（dm#A.1）。ストレージが使えないと呼ぶたびに変わるので、1 回だけ作って持つ */
let cachedDevice: string | null = null;
function device(): string {
  cachedDevice ??= deviceId(
    {
      // localStorage に触るだけで例外になる端末がある。deviceId の中で受ける
      getItem: (k) => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
    },
    (bytes) => crypto.getRandomValues(bytes),
  );
  return cachedDevice;
}

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
    void fetchPost(postId, device()).then((r) => {
      if (alive) setLookup(r);
    });
    return () => {
      alive = false;
    };
  }, [postId]);

  // いいねは押したらすぐ「済み」にし、届かなかったら戻す（もう一度押せる）
  const [likedHere, setLikedHere] = useState(false);
  const like = () => {
    setLikedHere(true);
    void sendLike(postId, device()).then((ok) => {
      if (!ok) setLikedHere(false);
    });
  };

  // 通報（mo#A.4）。結果の幕から開き、カテゴリと任意のコメントを送る
  const [reportOpen, setReportOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [comment, setComment] = useState("");
  const [reportState, setReportState] = useState<"idle" | "sending" | ReportResult>("idle");
  const draft = reportDraft(category, comment);
  const submitReport = () => {
    if (!draft.ok || reportState === "sending") return;
    setReportState("sending");
    void sendReport(postId, device(), draft.input).then((r) => {
      setReportState(r);
      if (r !== "failed") setReportOpen(false);
    });
  };

  // 「今の偏差値」（product#5.3）。点数のある結果が出るたびに、今の分布に当てた値を読む。
  // 校正済みでない投稿（stats が無い）はサーバが null を返すだけなので、聞かない
  const result = player.state.kind === "ENDED" ? player.state.result : null;
  const score = result?.via === "guest" ? result.score : null;
  const calibrated = lookup?.kind === "found" && lookup.post.stats !== null;
  const [deviation, setDeviation] = useState<number | null>(null);
  useEffect(() => {
    setDeviation(null);
    if (score === null || !calibrated) return;
    let alive = true;
    void fetchDeviation(postId, score).then((d) => {
      if (alive) setDeviation(d);
    });
    return () => {
      alive = false;
    };
  }, [postId, score, calibrated]);

  const view = gameView({
    state: player.state,
    meta: player.meta,
    halted: player.halted,
    lookup,
    likedHere,
    deviation,
  });
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
                {view.stats && <Stats stats={view.stats} />}
                <span>タップしてスタート</span>
              </button>
            )}

            {view.kind === "result" && !reportOpen && (
              <>
                <p style={styles.verb}>{view.main}</p>
                {view.sub && <p>{view.sub}</p>}
                {view.deviation && (
                  <p style={styles.deviation}>
                    今の偏差値 <strong style={styles.deviationValue}>{view.deviation}</strong>
                  </p>
                )}
                {view.stats && <Stats stats={view.stats} />}
                <button type="button" style={styles.button} onClick={player.again}>
                  もう一回
                </button>
                {view.like && (
                  <button
                    type="button"
                    style={view.like.liked ? styles.liked : styles.like}
                    disabled={view.like.liked}
                    aria-pressed={view.like.liked}
                    onClick={like}
                  >
                    {view.like.liked ? "♥ いいね済み" : "♡ いいね"}
                  </button>
                )}
              </>
            )}

            {view.kind === "result" && reportOpen && (
              <div style={styles.report}>
                <p style={styles.reportTitle}>このゲームを通報</p>
                <div style={styles.chips}>
                  {REPORT_OPTIONS.map((o) => (
                    <button
                      key={o.category}
                      type="button"
                      style={category === o.category ? styles.chipOn : styles.chip}
                      aria-pressed={category === o.category}
                      onClick={() => setCategory(o.category)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <textarea
                  style={styles.comment}
                  rows={3}
                  value={comment}
                  placeholder="くわしく（任意。運営だけが読みます）"
                  aria-label="通報のコメント（任意）"
                  onChange={(e) => setComment(e.target.value)}
                />
                <p style={draft.left < 0 ? styles.over : styles.small}>あと {draft.left} 文字</p>
                {reportState === "failed" && (
                  <p style={styles.over}>送れませんでした。もう一度お試しください</p>
                )}
                <div style={styles.row}>
                  <button type="button" style={styles.like} onClick={() => setReportOpen(false)}>
                    やめる
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    disabled={!draft.ok || reportState === "sending"}
                    onClick={submitReport}
                  >
                    {reportState === "sending" ? "送信中…" : "送信"}
                  </button>
                </div>
              </div>
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

            {(view.kind === "result" || dead) && !reportOpen && (
              <a href="/" style={styles.link}>
                ほかのゲームを続けて遊ぶ
              </a>
            )}

            {view.kind === "result" && view.canReport && !reportOpen && (
              <>
                {reportState === "reported" && <p style={styles.small}>通報しました</p>}
                {reportState === "own" && <p style={styles.small}>自分のゲームは通報できません</p>}
                {reportState !== "reported" && reportState !== "own" && (
                  <button
                    type="button"
                    style={styles.reportLink}
                    onClick={() => setReportOpen(true)}
                  >
                    通報
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

/** プレイ数といいね数（校正済みの投稿だけ。product#9 の 5） */
function Stats({ stats }: { stats: PostStats }) {
  return (
    <span style={styles.stats}>
      <span>▶ {stats.plays.toLocaleString("ja-JP")} プレイ</span>
      <span>♥ {stats.likes.toLocaleString("ja-JP")}</span>
    </span>
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
  stats: { display: "flex", gap: "1rem", fontSize: "0.9rem", opacity: 0.8 },
  deviation: { fontSize: "1rem", margin: 0 },
  deviationValue: { fontSize: "1.6rem", fontVariantNumeric: "tabular-nums" },
  button: {
    font: "inherit",
    padding: "0.7rem 1.4rem",
    borderRadius: "0.6rem",
    border: "1px solid #888",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
  },
  like: {
    font: "inherit",
    padding: "0.7rem 1.4rem",
    borderRadius: "0.6rem",
    border: "1px solid #888",
    background: "transparent",
    color: "#fff",
    cursor: "pointer",
  },
  liked: {
    font: "inherit",
    padding: "0.7rem 1.4rem",
    borderRadius: "0.6rem",
    border: "1px solid #ff6b8b",
    background: "transparent",
    color: "#ff6b8b",
  },
  small: { fontSize: "0.8rem", opacity: 0.7, margin: 0 },
  over: { fontSize: "0.8rem", color: "#ff6b8b", margin: 0 },
  reportLink: {
    all: "unset",
    fontSize: "0.8rem",
    opacity: 0.7,
    padding: "0.7rem",
    textDecoration: "underline",
    cursor: "pointer",
  },
  // 9:16 の枠に収まらない端末では、この中だけを縦に送る
  report: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.7rem",
    width: "100%",
    maxHeight: "100%",
    overflowY: "auto",
  },
  reportTitle: { fontWeight: 700, margin: 0 },
  chips: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0.4rem" },
  chip: {
    font: "inherit",
    fontSize: "0.85rem",
    padding: "0.5rem 0.8rem",
    borderRadius: "999px",
    border: "1px solid #888",
    background: "transparent",
    color: "#fff",
    cursor: "pointer",
  },
  chipOn: {
    font: "inherit",
    fontSize: "0.85rem",
    padding: "0.5rem 0.8rem",
    borderRadius: "999px",
    border: "1px solid #fff",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
  },
  comment: {
    font: "inherit",
    // 16px 未満だと iOS Safari が入力時に拡大する
    fontSize: "16px",
    width: "100%",
    boxSizing: "border-box",
    padding: "0.6rem",
    borderRadius: "0.6rem",
    border: "1px solid #888",
    background: "#111",
    color: "#fff",
    resize: "none",
    // 枠全体は選択を止めている（HOST_STAGE）。入力欄だけ戻さないと iOS Safari で文字が打てない
    userSelect: "text",
    WebkitUserSelect: "text",
  },
  row: { display: "flex", gap: "0.7rem" },
  link: { color: "#fff", padding: "0.7rem", textDecoration: "underline" },
} satisfies Record<string, React.CSSProperties>;
