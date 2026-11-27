// ラン画面（run#A.4〜A.11、A.14、product#4.4）。エンドレスのスタート画面から成績表まで。
// 進行は domain のラン Host、配線は `controller.ts`。ここは `view` を描き、iframe と操作をつなぐだけ。
// Host の層の見た目はドリルの絵（host-design.md）。部品は `Drill.tsx`、見た目は `drill.css`。
import "./drill.css";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { GameFrame } from "../game-frame.tsx";
import { HOST_STAGE } from "../host-stage.ts";
import { createRun, finishRun, putTurn, type RunPlan } from "./api.ts";
import { createRunController, type RunController, type RunView } from "./controller.ts";
import { Binding, Cover, EndStamp, Grading, Notice, QuestionPage, ReportPage } from "./Drill.tsx";
import { deviceId } from "./device-id.ts";
import { reportView } from "./display.ts";

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
    <Stage binding={<Binding turn={null} lap={0} lives={null} />}>
      <Notice>
        {loaded.kind === "loading" && <p className="dr-onpaper">読み込んでいます…</p>}
        {loaded.kind === "no_games" && <p className="dr-onpaper">遊べるゲームがまだありません。</p>}
        {loaded.kind === "run_not_found" && (
          <>
            <p className="dr-onpaper">このランは見つかりませんでした。</p>
            <button type="button" className="dr-button" onClick={onAgain}>
              新しいランで遊ぶ
            </button>
          </>
        )}
        {loaded.kind === "failed" && (
          <>
            <p className="dr-onpaper dr-warn">{loaded.message}</p>
            <button type="button" className="dr-button" onClick={onRetry}>
              もう一度
            </button>
          </>
        )}
      </Notice>
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

  const outside = <Binding turn={null} lap={0} lives={null} />;
  if (broken) {
    return (
      <Stage binding={outside}>
        <Notice>
          <p className="dr-onpaper dr-warn">{broken}</p>
        </Notice>
      </Stage>
    );
  }
  if (!ctl) return <Stage binding={outside}>{null}</Stage>;

  const view = ctl.view;
  const { run } = view;
  const playing = run.phase !== "idle" && run.phase !== "closing" && run.phase !== "finished";
  // 綴じ目に出す手番と周回。採点の間は終わった手番、幕間は次の手番（hd#A.3）
  const turn = run.outcomes.length + (run.phase === "flash" ? 0 : 1);
  const lap = run.phase === "interlude" ? (view.next?.lap ?? 0) : (run.current?.turn.lap ?? 0);

  return (
    <Stage binding={playing ? <Binding turn={turn} lap={lap} lives={run.lives} /> : outside}>
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

/** Host の層（表紙・問題のページ・採点・おわり・成績表）。iframe より上に置く（se#A.3、run#A.5、hd#A.9） */
function Layer(props: { ctl: RunController; view: RunView; runId: string; onAgain: () => void }) {
  const { ctl, view, runId, onAgain } = props;
  const { run } = view;

  if (run.phase === "running") return null;

  if (run.phase === "idle") {
    return (
      <Cover
        onStart={view.startable ? () => ctl.begin() : null}
        waiting={run.loadSkips > 0 ? "読み込みに時間がかかっています…" : "読み込んでいます…"}
      />
    );
  }

  if (run.phase === "interlude") {
    return (
      <QuestionPage
        turn={run.outcomes.length + 1}
        meta={view.next?.meta ?? null}
        lap={view.next?.lap ?? 0}
      />
    );
  }

  if (run.phase === "resuming") {
    return (
      <QuestionPage
        turn={run.outcomes.length + 1}
        meta={view.current}
        lap={run.current?.turn.lap ?? 0}
        resuming
      />
    );
  }

  if (run.phase === "flash") return <Grading flash={view.flash} />;

  // ここからはランが終わった後（closing / finished）
  if (run.ended === "error") {
    // 読み込みの skip が 3 本。成績表は出さない（run#A.6）
    return (
      <Notice>
        <p className="dr-verb">通信エラー</p>
        <p className="dr-onpaper">
          ゲームを読み込めませんでした。通信の状態を確かめて、もう一度試してください。
        </p>
        <button type="button" className="dr-button" onClick={onAgain}>
          もう一回
        </button>
      </Notice>
    );
  }

  if (view.report.kind === "ready") {
    return <Report view={view} runId={runId} onAgain={onAgain} />;
  }

  return (
    <EndStamp word={run.ended === "abandoned" ? "中断" : "おわり"}>
      {view.report.kind === "failed" ? (
        <>
          <p className="dr-onpaper">成績表を受け取れませんでした。</p>
          <button type="button" className="dr-button" onClick={() => ctl.retryFinish()}>
            もう一度受け取る
          </button>
          <button type="button" className="dr-button" onClick={onAgain}>
            もう一回
          </button>
        </>
      ) : (
        <p className="dr-onpaper dr-small">
          {run.phase === "closing" ? "記録を送っています…" : "成績表を読み込んでいます…"}
        </p>
      )}
    </EndStamp>
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
    <ReportPage report={r}>
      <button type="button" className="dr-button" onClick={onAgain}>
        もう一回
      </button>
      <button type="button" className="dr-button" onClick={copy}>
        {copied ? "コピーしました" : "同じ山札のリンクをコピー"}
      </button>
    </ReportPage>
  );
}

/** 画面の枠。上に綴じ目（Host のヘッダー）、その下に縦長 9:16 のゲームの領域（gc#A.2、hd#A.3） */
export function Stage({ binding, children }: { binding: ReactNode; children: ReactNode }) {
  return (
    <main style={styles.stage}>
      <div className="dr-col">
        {binding}
        <div className="dr-box">{children}</div>
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
  },
} satisfies Record<string, React.CSSProperties>;
