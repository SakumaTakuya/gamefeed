// ラン画面（run#A.4〜A.11、A.14、product#4.4）。エンドレスのスタート画面から成績表まで。
// 進行は domain のラン Host、配線は `controller.ts`。ここは `view` を描き、iframe と操作をつなぐだけ。
import { useEffect, useReducer, useRef, useState } from "react";
import { GameFrame } from "../game-frame.tsx";
import { HOST_STAGE } from "../host-stage.ts";
import { createRun, finishRun, putTurn, type RunPlan } from "./api.ts";
import { createRunController, type RunController, type RunView } from "./controller.ts";
import { deviceId } from "./device-id.ts";
import { flashText, inputLabel, livesText, reportView } from "./display.ts";

const GAMES_ORIGIN: string | undefined = import.meta.env.VITE_GAMES_ORIGIN;

type Loaded =
  | { kind: "loading" }
  | { kind: "ok"; plan: RunPlan }
  | { kind: "no_games" }
  | { kind: "run_not_found" }
  | { kind: "failed"; message: string };

/** このページの間の `device_id`。ストレージが使えない端末でも、ページの中では同じ値にする */
let cachedDevice: string | null = null;
function device(): string {
  cachedDevice ??= deviceId(
    {
      getItem: (k) => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
    },
    (bytes) => crypto.getRandomValues(bytes),
  );
  return cachedDevice;
}

async function loadPlan(fromRun: string | null): Promise<Loaded> {
  if (!GAMES_ORIGIN) {
    return { kind: "failed", message: "配信オリジン（VITE_GAMES_ORIGIN）が設定されていません。" };
  }
  const result = await createRun(device(), fromRun);
  if (result.ok) return { kind: "ok", plan: result.plan };
  if (result.error === "failed") {
    return { kind: "failed", message: `ランを作れませんでした（${result.status}）。` };
  }
  return { kind: result.error };
}

/** `/` と `/r/<run_id>`（run#A.14）。fromRun があれば、その山札で新しいランを作る */
export function RunPage({ fromRun }: { fromRun: string | null }) {
  // 「もう一回」は新しい山札（run#A.11）。共有リンクから来ていても、2 回目からは普通のラン
  const [attempt, setAttempt] = useState({ n: 0, fromRun });
  const again = () => {
    if (location.pathname !== "/") history.replaceState(null, "", "/");
    setAttempt((a) => ({ n: a.n + 1, fromRun: null }));
  };
  // ランを作れなかったときのやり直しは、同じ山札の指定のまま
  const retry = () => setAttempt((a) => ({ ...a, n: a.n + 1 }));
  return <Attempt key={attempt.n} fromRun={attempt.fromRun} onAgain={again} onRetry={retry} />;
}

function Attempt(props: { fromRun: string | null; onAgain: () => void; onRetry: () => void }) {
  const { fromRun, onAgain, onRetry } = props;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  // ランの作成は 1 回だけ（StrictMode の effect の再実行で 2 つ作らない）
  const request = useRef<Promise<Loaded> | null>(null);

  useEffect(() => {
    let cancelled = false;
    request.current ??= loadPlan(fromRun).catch(
      (e): Loaded => ({ kind: "failed", message: String(e?.message ?? e) }),
    );
    request.current.then((l) => !cancelled && setLoaded(l));
    return () => {
      cancelled = true;
    };
  }, [fromRun]);

  if (loaded.kind === "ok" && GAMES_ORIGIN) {
    return <Player plan={loaded.plan} gamesOrigin={GAMES_ORIGIN} onAgain={onAgain} />;
  }
  return (
    <Stage header={null}>
      <div style={styles.layer}>
        {loaded.kind === "loading" && <p>読み込んでいます…</p>}
        {loaded.kind === "no_games" && <p>遊べるゲームがまだありません。</p>}
        {loaded.kind === "run_not_found" && (
          <>
            <p>このランは見つかりませんでした。</p>
            <button type="button" style={styles.button} onClick={onAgain}>
              新しいランで遊ぶ
            </button>
          </>
        )}
        {loaded.kind === "failed" && (
          <>
            <p style={styles.error}>{loaded.message}</p>
            <button type="button" style={styles.button} onClick={onRetry}>
              もう一度
            </button>
          </>
        )}
      </div>
    </Stage>
  );
}

function Player(props: { plan: RunPlan; gamesOrigin: string; onAgain: () => void }) {
  const { plan, gamesOrigin, onAgain } = props;
  const els = useRef(new Map<number, HTMLIFrameElement>());
  const [ctl, setCtl] = useState<RunController | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let c: RunController;
    try {
      c = createRunController({
        plan,
        gamesOrigin,
        env: {
          now: () => performance.now(),
          setTimer: (cb, ms) => window.setTimeout(cb, ms),
          clearTimer: (h) => window.clearTimeout(h as number),
          // Guest は不透明オリジン（sandbox）なので、宛先のオリジンは指定できない（protocol#A.1）
          post: (iframe, m) => els.current.get(iframe)?.contentWindow?.postMessage(m, "*"),
          newSessionId: () => crypto.randomUUID(),
          putTurn: (turn, body) => putTurn(device(), plan.runId, turn, body),
          finish: () => finishRun(device(), plan.runId),
        },
        onChange: rerender,
      });
    } catch (e) {
      setBroken(String((e as Error)?.message ?? e));
      return;
    }
    setCtl(c);

    const onMessage = (ev: MessageEvent) => {
      // 不透明オリジンなので origin は見ず、送り元が自分の iframe であることを確かめる（protocol#A.1）
      for (const [iframe, el] of els.current) {
        if (el.contentWindow && ev.source === el.contentWindow) {
          c.receive(iframe, ev.data);
          return;
        }
      }
    };
    const onVisibility = () => c.setHidden(document.hidden);
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hidden) c.setHidden(true);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      c.dispose();
    };
  }, [plan, gamesOrigin]);

  if (broken) {
    return (
      <Stage header={null}>
        <div style={styles.layer}>
          <p style={styles.error}>{broken}</p>
        </div>
      </Stage>
    );
  }
  if (!ctl) return <Stage header={null}>{null}</Stage>;

  const view = ctl.view;
  const { run } = view;
  const playing = run.phase !== "idle" && run.phase !== "closing" && run.phase !== "finished";

  return (
    <Stage
      header={
        playing ? (
          <>
            <span>{livesText(run.lives)}</span>
            <span>{run.outcomes.length + (run.phase === "flash" ? 0 : 1)} 本目</span>
          </>
        ) : null
      }
    >
      {view.frames.map((f) => (
        <GameFrame
          key={f.iframe}
          ref={(el) => {
            if (el) els.current.set(f.iframe, el);
            else els.current.delete(f.iframe);
          }}
          src={f.src}
          // 先読みは不可視（run#A.4）
          visible={f.visible}
          onLoad={() => ctl.frameLoaded(f.iframe)}
        />
      ))}
      <Layer ctl={ctl} view={view} runId={plan.runId} onAgain={onAgain} />
    </Stage>
  );
}

/** Host の層（幕間・結果フラッシュ・スタート・成績表）。iframe より上に置く（se#A.3、run#A.5） */
function Layer(props: { ctl: RunController; view: RunView; runId: string; onAgain: () => void }) {
  const { ctl, view, runId, onAgain } = props;
  const { run } = view;

  if (run.phase === "running") return null;

  if (run.phase === "idle") {
    return view.startable ? (
      <button type="button" style={styles.start} onClick={() => ctl.begin()}>
        <span style={styles.big}>GameFeed</span>
        <span>タップしてスタート</span>
      </button>
    ) : (
      <div style={styles.layer}>
        <p>{run.loadSkips > 0 ? "読み込みに時間がかかっています…" : "読み込んでいます…"}</p>
      </div>
    );
  }

  if (run.phase === "interlude") {
    const next = view.next;
    return (
      <div style={styles.layer}>
        {next?.meta ? (
          <>
            <p style={styles.big}>{next.meta.verb}</p>
            <p>{inputLabel(next.meta.input)}</p>
          </>
        ) : (
          <p style={styles.big}>…</p>
        )}
        {next && next.lap > 0 && <p style={styles.small}>{next.lap + 1} 周目</p>}
      </div>
    );
  }

  if (run.phase === "resuming") {
    return (
      <div style={styles.layer}>
        <p>続きから</p>
        {view.current && <p style={styles.big}>{view.current.verb}</p>}
      </div>
    );
  }

  if (run.phase === "flash") {
    const text = view.flash ? flashText(view.flash) : null;
    return (
      <div style={styles.layer}>
        {text && (
          <>
            <p style={styles.big}>{text.main}</p>
            {text.miss && <p style={styles.miss}>ミス</p>}
            {/* 応答が届く前と後で高さが変わらないよう、行は常に置く */}
            <p style={styles.sub}>{text.sub ?? "\u00a0"}</p>
          </>
        )}
      </div>
    );
  }

  // ここからはランが終わった後（closing / finished）
  if (run.ended === "error") {
    // 読み込みの skip が 3 本。成績表は出さない（run#A.6）
    return (
      <div style={styles.layer}>
        <p style={styles.big}>通信エラー</p>
        <p>ゲームを読み込めませんでした。通信の状態を確かめて、もう一度試してください。</p>
        <button type="button" style={styles.button} onClick={onAgain}>
          もう一回
        </button>
      </div>
    );
  }

  if (view.report.kind === "ready") {
    return <Report view={view} runId={runId} onAgain={onAgain} />;
  }

  return (
    <div style={styles.layer}>
      <p style={styles.big}>{run.ended === "abandoned" ? "中断" : "終了"}</p>
      {view.report.kind === "failed" ? (
        <>
          <p>成績表を受け取れませんでした。</p>
          <button type="button" style={styles.button} onClick={() => ctl.retryFinish()}>
            もう一度受け取る
          </button>
          <button type="button" style={styles.button} onClick={onAgain}>
            もう一回
          </button>
        </>
      ) : (
        <p style={styles.small}>
          {run.phase === "closing" ? "記録を送っています…" : "成績表を読み込んでいます…"}
        </p>
      )}
    </div>
  );
}

function Report(props: { view: RunView; runId: string; onAgain: () => void }) {
  const { view, runId, onAgain } = props;
  const [copied, setCopied] = useState(false);
  if (view.report.kind !== "ready") return null;
  const r = reportView(view.report.report, { unsettled: view.unsettled, titles: view.titles });
  const link = `${location.origin}/r/${runId}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("コピーできませんでした。下のリンクを選んでコピーしてください。", link);
    }
  };

  return (
    <div style={styles.report}>
      <p style={styles.small}>{r.status}</p>
      <p style={styles.big}>{r.heading}</p>
      <p>{r.overall}</p>
      {r.notice && <p style={styles.error}>{r.notice}</p>}
      <ol style={styles.rows}>
        {r.rows.map((row) => (
          <li key={row.no} style={styles.row}>
            <span style={styles.rowNo}>{row.no}</span>
            <span style={styles.rowTitle}>
              {row.title ?? "—"}
              {row.speed && <span style={styles.small}> {row.speed}</span>}
            </span>
            <span>
              {row.note && <span style={styles.small}>{row.note} </span>}
              {row.value}
              {row.miss && <span style={styles.miss}> ミス</span>}
            </span>
          </li>
        ))}
      </ol>
      <button type="button" style={styles.button} onClick={onAgain}>
        もう一回
      </button>
      <button type="button" style={styles.button} onClick={copy}>
        {copied ? "コピーしました" : "同じ山札のリンクをコピー"}
      </button>
    </div>
  );
}

/** 画面の枠。上端に Host のヘッダー、その下に縦長 9:16 のゲームの領域（gc#A.2） */
function Stage({ header, children }: { header: React.ReactNode; children: React.ReactNode }) {
  return (
    <main style={styles.stage}>
      <div style={styles.column}>
        <header style={styles.header}>{header}</header>
        <div style={styles.frameBox}>{children}</div>
      </div>
    </main>
  );
}

/** Host が描く層の見た目。ヘッダーと同じ色にして、ゲームが描く偽の UI と区別できるようにする（run#A.5） */
const HOST_SKIN = { color: "#fff", background: "#16161d" } as const;
const HEADER_HEIGHT = "2.5rem";

const styles = {
  stage: {
    ...HOST_STAGE,
    position: "fixed",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "#000",
    fontFamily: "system-ui, sans-serif",
  },
  column: { display: "flex", flexDirection: "column" },
  header: {
    ...HOST_SKIN,
    height: HEADER_HEIGHT,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 0.9rem",
    fontSize: "0.95rem",
  },
  // 縦長 9:16 を基準に、ヘッダーを除いた画面に収まる最大の大きさ（gc#A.2）
  frameBox: {
    position: "relative",
    height: `min(calc(100dvh - ${HEADER_HEIGHT}), calc(100vw * 16 / 9))`,
    aspectRatio: "9 / 16",
    background: "#111",
    overflow: "hidden",
  },
  layer: {
    ...HOST_SKIN,
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.8rem",
    padding: "1.5rem",
    textAlign: "center",
  },
  start: {
    all: "unset",
    ...HOST_SKIN,
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1.2rem",
    cursor: "pointer",
  },
  report: {
    ...HOST_SKIN,
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.6rem",
    padding: "1.5rem 1rem",
    textAlign: "center",
    overflowY: "auto",
  },
  rows: { listStyle: "none", margin: "0.5rem 0", padding: 0, width: "100%" },
  row: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.6rem",
    padding: "0.35rem 0.2rem",
    borderBottom: "1px solid #333",
    textAlign: "left",
  },
  rowNo: { width: "1.6rem", opacity: 0.6, textAlign: "right" },
  rowTitle: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  big: { fontSize: "2.5rem", fontWeight: 700, margin: 0 },
  sub: { margin: 0, fontSize: "1.1rem" },
  small: { margin: 0, fontSize: "0.85rem", opacity: 0.75 },
  miss: { margin: 0, color: "#ff6b6b", fontWeight: 700 },
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
} satisfies Record<string, React.CSSProperties>;
