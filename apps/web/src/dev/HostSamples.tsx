// 開発用の見本（`/dev/host`。`vite` の開発サーバでだけ出る）。サーバなしで、Host の層の各状態を並べて見る。
// ドリルの絵（host-design.md）を直したら、ここをブラウザで開いて確かめる。
import "../run/drill.css";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunReport } from "../run/api.ts";
import type { FlashView } from "../run/controller.ts";
import {
  Binding,
  Cover,
  EndStamp,
  Grading,
  Notice,
  QuestionPage,
  ReportPage,
} from "../run/Drill.tsx";
import { reportView } from "../run/display.ts";
import { flipFrame, type Paper } from "../run/drill.ts";
import { Pages, paintFlip } from "../run/Pages.tsx";

const flash = (over: Partial<FlashView>): FlashView => ({
  via: "guest",
  score: 72,
  miss: false,
  isNew: false,
  deviation: null,
  ratio: null,
  ...over,
});

const TITLES = [
  "もぐらたたき",
  "スパッと",
  "ためジャンプ",
  "ながおし",
  "ハードル",
  "やじるしフリック",
];
const DEVS: (number | null)[] = [
  58.2,
  63.4,
  47.1,
  null,
  71.0,
  38.3,
  55.5,
  49.9,
  61.2,
  null,
  57.3,
  36.4,
];
const report: RunReport = {
  run_id: "01M782MV00TMYMTHTGG5C6KS3A",
  mode: "endless",
  ended: "lives",
  reached: DEVS.length,
  avg_deviation: 52.1,
  symbols: null,
  turns: DEVS.map((d, i) => ({
    turn: i,
    post_id: `P${i % TITLES.length}`,
    kind: i === 9 ? "skip" : d !== null && d < 40 ? "miss" : "ok",
    deviation: d,
    ratio: i === 3 ? 0.62 : null,
    is_new: i === 3,
    speed: i >= 6 ? 1.125 : 1,
  })),
};
const titles = Object.fromEntries(TITLES.map((t, i) => [`P${i}`, { title: t }]));

const SCREEN = {
  position: "absolute",
  inset: 0,
  font: "14px system-ui",
  display: "grid",
  placeContent: "center",
} as const;

/** ゲームの画面の代わり。本番では配信オリジンの iframe（`GameFrame`）がここに来る */
function Screen(props: { n: number; ref?: React.Ref<HTMLDivElement> }) {
  const hue = (props.n * 67) % 360;
  return (
    <div
      ref={props.ref}
      style={{
        ...SCREEN,
        background: `linear-gradient(hsl(${hue} 60% 8%), hsl(${hue} 70% 22%))`,
        color: `hsl(${hue} 90% 75%)`,
      }}
    >
      ゲーム {props.n} の画面
    </div>
  );
}

/** 見本の枠だけ（下に何も敷かない） */
function Frame(props: { name: string; binding: ReactNode; children: ReactNode }) {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ font: "13px system-ui", color: "#ccc", marginBottom: 6 }}>
        {props.name}
      </figcaption>
      <div className="dr-col" style={{ width: 300 }} data-sample={props.name}>
        {props.binding}
        <div className="dr-box">{props.children}</div>
      </div>
    </figure>
  );
}

/** めくりの途中で止めた 1 コマ（hd#A.7）。採点の紙をめくって、次の問題のページが出るところ */
function FlipStill({ t }: { t: number }) {
  const screen = useRef<HTMLDivElement | null>(null);
  const leaf = useRef<HTMLDivElement | null>(null);
  const back = useRef<HTMLDivElement | null>(null);
  const backShade = useRef<HTMLElement | null>(null);
  const shadow = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const box = leaf.current?.parentElement;
    if (!box || !screen.current || !leaf.current) return;
    screen.current.style.zIndex = "2";
    paintFlip(
      {
        paper: [screen.current, leaf.current],
        back: back.current,
        backShade: backShade.current,
        shadow: shadow.current,
      },
      flipFrame(t, box.clientWidth, box.clientHeight),
    );
  }, [t]);
  return (
    <Frame name={`めくりの途中（t = ${t}）`} binding={<Binding turn={6} lap={0} lives={3} />}>
      <Screen n={5} ref={screen} />
      <div className="dr-sheet">
        <QuestionPage turn={6} meta={{ verb: "よけろ！", input: "drag" }} lap={0} />
      </div>
      <div ref={leaf} className="dr-sheet dr-leaf">
        <Grading flash={flash({ deviation: 63.4 })} />
      </div>
      <div ref={shadow} className="dr-flip-shadow" />
      <div ref={back} className="dr-flip-back">
        <i ref={backShade} />
      </div>
    </Frame>
  );
}

/** 1 ランの流れ（表紙 → 2 問 → おわり → 成績表）を、本番と同じ `Pages` でめくる。繰り返す */
const FLOW: { paper: Paper; ms: number }[] = [
  { paper: "cover", ms: 1200 },
  { paper: "question", ms: 1000 },
  { paper: "game", ms: 900 },
  { paper: "grading", ms: 500 },
  { paper: "question", ms: 1000 },
  { paper: "game", ms: 900 },
  { paper: "grading", ms: 500 },
  { paper: "end", ms: 900 },
  { paper: "report", ms: 2200 },
];
function FlipFlow() {
  const [step, setStep] = useState(0);
  const screen = useRef<HTMLDivElement | null>(null);
  const at = FLOW[step % FLOW.length] as (typeof FLOW)[number];
  useEffect(() => {
    const h = window.setTimeout(() => setStep((s) => s + 1), at.ms);
    return () => window.clearTimeout(h);
  }, [at]);
  const i = step % FLOW.length;
  // 何問目か。2 つ目の問題のページから第 2 問
  const turn = i >= 4 ? 2 : 1;
  // 画面に出ているゲーム。問題のページの間は、まだ前のゲームの画面が下にある（run#A.5 の 7）
  const game = i >= 5 ? 2 : i >= 2 ? 1 : 0;
  const inRun = i >= 1 && i <= 6;
  return (
    <Frame
      name="流れ: めくり（繰り返し）"
      binding={
        inRun ? (
          <Binding turn={turn} lap={0} lives={3} />
        ) : (
          <Binding turn={null} lap={0} lives={null} />
        )
      }
    >
      {game > 0 && <Screen key={game} n={game} ref={screen} />}
      <Pages paper={at.paper} frames={() => (screen.current ? [screen.current] : [])}>
        {at.paper === "cover" && <Cover onStart={() => {}} waiting={null} />}
        {at.paper === "question" && (
          <QuestionPage
            turn={turn}
            meta={
              turn === 1
                ? { verb: "うけとめろ！", input: "drag" }
                : { verb: "タップ！", input: "tap" }
            }
            lap={0}
          />
        )}
        {at.paper === "grading" && (
          <Grading
            flash={flash(turn === 1 ? { deviation: 63.4 } : { score: 41, deviation: 52.3 })}
          />
        )}
        {at.paper === "end" && <EndStamp word="おわり" />}
        {at.paper === "report" && (
          <ReportPage report={reportView(report, { unsettled: 0, titles })}>
            <button type="button" className="dr-button">
              もう一回
            </button>
          </ReportPage>
        )}
      </Pages>
    </Frame>
  );
}

/** 見本の 1 枚。下に暗い「ゲームの画面」の代わりを敷く */
function Sample(props: { name: string; binding: ReactNode; children: ReactNode }) {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ font: "13px system-ui", color: "#ccc", marginBottom: 6 }}>
        {props.name}
      </figcaption>
      <div className="dr-col" style={{ width: 300 }} data-sample={props.name}>
        {props.binding}
        <div className="dr-box">
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "linear-gradient(#070512, #22093c)",
              color: "#7df9ff",
              font: "14px system-ui",
              display: "grid",
              placeContent: "center",
            }}
          >
            ゲームの画面
          </div>
          {props.children}
        </div>
      </div>
    </figure>
  );
}

/** ミスの流れを繰り返す見本: 遊んでいる（0.9 秒）→ 採点（0.5 秒）→ 次の問題のページ（1.0 秒） */
function MissFlow() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const ms = [900, 500, 1000][step % 3] as number;
    const h = window.setTimeout(() => setStep((s) => s + 1), ms);
    return () => window.clearTimeout(h);
  }, [step]);
  const phase = step % 3;
  return (
    <Sample
      name="流れ: ミスで残機が減る（繰り返し）"
      binding={
        <Binding turn={phase === 2 ? 6 : 5} lap={0} lives={phase === 0 ? 3 : 2} lost={phase > 0} />
      }
    >
      {phase === 1 && <Grading flash={flash({ score: 3, miss: true })} lives={2} />}
      {phase === 2 && <QuestionPage turn={6} meta={{ verb: "よけろ！", input: "drag" }} lap={0} />}
    </Sample>
  );
}

export function HostSamples() {
  const outside = <Binding turn={null} lap={0} lives={null} />;
  const inRun = (turn: number, lap: number, lives: number) => (
    <Binding turn={turn} lap={lap} lives={lives} />
  );
  return (
    <main
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 20,
        padding: 20,
        background: "#222",
        minHeight: "100vh",
      }}
    >
      <Sample name="表紙" binding={outside}>
        <Cover onStart={() => {}} waiting={null} />
      </Sample>
      <Sample name="表紙（読み込み中）" binding={outside}>
        <Cover onStart={null} waiting="読み込んでいます…" />
      </Sample>
      <Sample name="問題のページ" binding={inRun(1, 0, 3)}>
        <QuestionPage turn={1} meta={{ verb: "うけとめろ！", input: "drag" }} lap={0} />
      </Sample>
      <Sample name="問題のページ（2 周目、長い動詞）" binding={inRun(19, 1, 2)}>
        <QuestionPage turn={19} meta={{ verb: "ふくらませ！", input: "hold" }} lap={1} />
      </Sample>
      <Sample name="問題のページ（まだ届かない）" binding={inRun(3, 0, 3)}>
        <QuestionPage turn={3} meta={null} lap={0} />
      </Sample>
      <Sample name="続きから" binding={inRun(4, 0, 3)}>
        <QuestionPage turn={4} meta={{ verb: "タップ！", input: "tap" }} lap={0} resuming />
      </Sample>
      <Sample name="採点: 花丸" binding={inRun(5, 0, 3)}>
        <Grading flash={flash({ deviation: 63.4 })} />
      </Sample>
      <Sample name="採点: 丸" binding={inRun(5, 0, 3)}>
        <Grading flash={flash({ score: 41, deviation: 52.3 })} />
      </Sample>
      <Sample name="採点: 三角" binding={inRun(5, 0, 3)}>
        <Grading flash={flash({ score: 18, deviation: 44.0 })} />
      </Sample>
      <Sample name="採点: ばつ（ミス）" binding={<Binding turn={5} lap={0} lives={2} lost />}>
        <Grading flash={flash({ score: 3, miss: true, deviation: 31.2 })} lives={2} />
      </Sample>
      <MissFlow />
      <FlipFlow />
      <FlipStill t={0.25} />
      <FlipStill t={0.5} />
      <FlipStill t={0.75} />
      <Sample name="採点: 応答がまだ" binding={inRun(5, 0, 3)}>
        <Grading flash={flash({ score: 128 })} />
      </Sample>
      <Sample name="採点: 校正中" binding={inRun(5, 0, 3)}>
        <Grading flash={flash({ score: 9, isNew: true, ratio: 0.62 })} />
      </Sample>
      <Sample name="採点: 時間切れ" binding={inRun(5, 0, 3)}>
        <Grading flash={flash({ via: "timeout", score: null })} />
      </Sample>
      <Sample name="おわり" binding={outside}>
        <EndStamp word="おわり">
          <p className="dr-onpaper dr-small">記録を送っています…</p>
        </EndStamp>
      </Sample>
      <Sample name="成績表" binding={outside}>
        <ReportPage report={reportView(report, { unsettled: 0, titles })}>
          <button type="button" className="dr-button">
            もう一回
          </button>
          <button type="button" className="dr-button">
            同じ山札のリンクをコピー
          </button>
        </ReportPage>
      </Sample>
      <Sample name="知らせ（エラー）" binding={outside}>
        <Notice>
          <p className="dr-verb">通信エラー</p>
          <p className="dr-onpaper">ゲームを読み込めませんでした。</p>
          <button type="button" className="dr-button">
            もう一回
          </button>
        </Notice>
      </Sample>
    </main>
  );
}
