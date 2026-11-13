// 下書きの試遊ページ（mc#A.9、product#9 の 3、protocol#A.11）。
// 作者がログインして試遊トークンを取り、配信オリジンのゲームを iframe に入れて遊ぶ。
import type { GameMeta, Speed } from "@gamefeed/domain";
import { createHost, type Host } from "@gamefeed/sdk";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { gameUrl } from "../game-url.ts";
import { diagnose } from "./diagnose.ts";

type Access =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "not_found" }
  | { kind: "failed"; message: string }
  | { kind: "ok"; src: string };

const GAMES_ORIGIN: string | undefined = import.meta.env.VITE_GAMES_ORIGIN;
const SPEED: Speed = 1;
/** 最初の load から ready までに待つ時間（ms）。過ぎたら読み込み失敗として扱う */
const READY_TIMEOUT_MS = 5000;

/** 試遊トークンを取り、iframe の URL を作る（se#A.5）。 */
async function loadAccess(postId: string): Promise<Access> {
  if (!GAMES_ORIGIN) {
    return { kind: "failed", message: "配信オリジン（VITE_GAMES_ORIGIN）が設定されていません。" };
  }
  const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/play-token`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 401) return { kind: "signed_out" };
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; missing?: string[] };
    const detail = body.missing?.length ? `（${body.missing.join(", ")}）` : "";
    return {
      kind: "failed",
      message: `サーバーの応答が ${res.status} ${body.error ?? ""}${detail} でした。`,
    };
  }
  const { token } = (await res.json()) as { token: string };
  return { kind: "ok", src: gameUrl(GAMES_ORIGIN, postId, token) };
}

async function signInWithGoogle(): Promise<void> {
  const res = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: location.pathname }),
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string };
  if (!res.ok || !data.url) throw new Error(`ログインを始められませんでした（${res.status}）`);
  location.href = data.url;
}

export function DraftPage({ postId }: { postId: string }) {
  const [access, setAccess] = useState<Access>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadAccess(postId)
      .then((a) => !cancelled && setAccess(a))
      .catch((e) => !cancelled && setAccess({ kind: "failed", message: String(e?.message ?? e) }));
    return () => {
      cancelled = true;
    };
  }, [postId]);

  if (access.kind === "ok") return <Player postId={postId} src={access.src} />;
  return (
    <main style={styles.page}>
      <h1 style={styles.h1}>下書きの試遊</h1>
      {access.kind === "loading" && <p>読み込んでいます…</p>}
      {access.kind === "signed_out" && <SignIn />}
      {access.kind === "not_found" && (
        <p>
          この下書きは開けません。公開済みか、削除されたか、別のアカウントの下書きです。ログイン中のアカウントを確かめてください。
        </p>
      )}
      {access.kind === "failed" && <p style={styles.error}>{access.message}</p>}
    </main>
  );
}

function SignIn() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <p>下書きを遊べるのは作者だけです。投稿に使った Google アカウントでログインしてください。</p>
      <button
        type="button"
        style={styles.button}
        onClick={() => signInWithGoogle().catch((e) => setError(String(e?.message ?? e)))}
      >
        Google でログイン
      </button>
      {error && <p style={styles.error}>{error}</p>}
    </>
  );
}

function Player({ postId, src }: { postId: string; src: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<Host | null>(null);
  const loads = useRef(0);
  /** 最後に届いたメタ宣言。破棄した後も診断に載せるために持っておく */
  const lastMeta = useRef<GameMeta | null>(null);
  /** iframe を外した理由（ページ移動など、Host 側で見つけたもの） */
  const [halted, setHalted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Host ブリッジは iframe 1 つにつき 1 つ。再描画や StrictMode の再実行で作り直さない
  if (!hostRef.current) {
    hostRef.current = createHost(
      {
        // Guest は不透明オリジン（sandbox）なので、宛先のオリジンは指定できない（protocol#A.1）
        post: (m) => frameRef.current?.contentWindow?.postMessage(m, "*"),
        now: () => performance.now(),
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
        newSessionId: () => crypto.randomUUID(),
        newSeed: () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
      },
      rerender,
    );
  }
  const host = hostRef.current;
  const state = host.state;

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // 不透明オリジンなので origin は見ず、送り元が自分の iframe であることを確かめる（protocol#A.1）
      const frame = frameRef.current?.contentWindow;
      if (!frame || ev.source !== frame) return;
      host.receive(ev.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [host]);

  // ready が届いたら、すぐ遊べるように準備しておく
  useEffect(() => {
    if (state.kind === "READY") host.init({ speed: SPEED });
  }, [state.kind, host]);

  const onLoad = useCallback(() => {
    loads.current += 1;
    // 2 回目以降の load は iframe 自身の遷移。即座に破棄する（se#A.3）
    if (loads.current > 1) {
      host.destroy();
      setHalted("ゲームが別のページへ移動しようとしたため止めました");
      return;
    }
    // 読み込めたのに ready が届かない（配信が 404、SDK より前の例外など）なら、待ち続けずに知らせる
    window.setTimeout(() => {
      if (host.state.kind !== "LOADING") return;
      host.destroy();
      setHalted(
        "ゲームから ready が届きませんでした。配信が 404（試遊トークンの期限切れなど）か、ゲームの読み込み中に例外が出ています",
      );
    }, READY_TIMEOUT_MS);
  }, [host]);

  if ("meta" in state) lastMeta.current = state.meta;
  const meta = lastMeta.current;
  const result = state.kind === "ENDED" ? state.result : null;
  const problem = halted ?? host.problem;
  const dead = state.kind === "DESTROYED";

  const copy = async () => {
    const text = diagnose({
      postId,
      meta,
      speed: SPEED,
      result,
      inputs: host.inputs.length,
      problem,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("コピーできませんでした。下のテキストを選んでコピーしてください。", text);
    }
  };

  return (
    <main style={styles.stage}>
      <div style={styles.frameBox}>
        {!dead && (
          <iframe
            ref={frameRef}
            title="ゲーム"
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            {...{ credentialless: "" }}
            onLoad={onLoad}
            style={styles.frame}
          />
        )}

        {/* Host の UI は iframe より上のレイヤに置く（se#A.3）。遊んでいる間は何もかぶせない */}
        {state.kind !== "RUNNING" && (
          <div style={styles.overlay}>
            {(state.kind === "LOADING" || state.kind === "READY") && (
              <p>ゲームを読み込んでいます…</p>
            )}

            {state.kind === "INITED" && meta && (
              <button type="button" style={styles.start} onClick={() => host.start()}>
                <span style={styles.verb}>{meta.verb}</span>
                <span style={styles.title}>{meta.title}</span>
                <span>タップしてスタート</span>
              </button>
            )}

            {result && meta && (
              <>
                <p style={styles.verb}>
                  {result.via === "guest"
                    ? `${result.score} 点`
                    : result.via === "timeout"
                      ? "時間切れ"
                      : "エラー"}
                </p>
                <p>
                  {result.via === "guest"
                    ? `目標 ${meta.target} 点${result.score >= meta.target ? "を達成" : "に届かず"}`
                    : result.via === "timeout"
                      ? "ゲームから終了の合図が届きませんでした"
                      : (problem ?? "ゲームの中で例外が出ました")}
                </p>
                <button
                  type="button"
                  style={styles.button}
                  onClick={() => host.init({ speed: SPEED })}
                >
                  もう一回
                </button>
              </>
            )}

            {dead && (
              <>
                <p style={styles.error}>{problem ?? "ゲームを止めました"}</p>
                <button type="button" style={styles.button} onClick={() => location.reload()}>
                  読み込み直す
                </button>
              </>
            )}

            {(result || dead) && (
              <button type="button" style={styles.button} onClick={copy}>
                {copied ? "コピーしました" : "診断をコピー"}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

const styles = {
  page: {
    maxWidth: "28rem",
    margin: "3rem auto",
    padding: "0 1rem",
    lineHeight: 1.7,
    fontFamily: "system-ui, sans-serif",
  },
  h1: { fontSize: "1.25rem" },
  error: { color: "#ff6b6b" },
  button: {
    font: "inherit",
    padding: "0.7rem 1.4rem",
    borderRadius: "0.6rem",
    border: "1px solid #888",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
  },
  stage: {
    position: "fixed",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "#000",
    fontFamily: "system-ui, sans-serif",
  },
  // 縦長 9:16 を基準に、画面に収まる最大の大きさ（gc#A.2）
  frameBox: {
    position: "relative",
    height: "min(100dvh, calc(100vw * 16 / 9))",
    aspectRatio: "9 / 16",
    background: "#111",
    overflow: "hidden",
  },
  frame: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    border: 0,
    display: "block",
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
} satisfies Record<string, React.CSSProperties>;
