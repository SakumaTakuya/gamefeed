// 開発用の見本（`/dev/host`。`vite` の開発サーバでだけ出る）。サーバなしで、Host の層の各状態を並べて見る。
// ドリルの絵（host-design.md）を直したら、ここをブラウザで開いて確かめる。
import "../run/drill.css";
import type { ReactNode } from "react";
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
      <Sample name="採点: ばつ（ミス）" binding={inRun(5, 0, 2)}>
        <Grading flash={flash({ score: 3, miss: true, deviation: 31.2 })} />
      </Sample>
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
