// ドリルの絵（host-design.md）。ラン画面の Host の層の部品。値を受け取って描くだけで、進行は知らない。
// 見た目は `drill.css`（読み込むのはページの側）。印とめくりの計算は `drill.ts`。
import { ENDLESS_LIVES, ENDLESS_TURN_LIMIT, type InputKind } from "@gamefeed/domain";
import type { ReactNode } from "react";
import type { FlashView } from "./controller.ts";
import {
  flashMark,
  flashText,
  inputLabel,
  lapLabel,
  type ReportView,
  turnLabel,
} from "./display.ts";
import type { Mark } from "./drill.ts";

/* ---------- 印（hd#A.6）。一筆で描けるよう、線の列にする ---------- */

function strokes(mark: Mark): string[] {
  if (mark === "batsu") return ["M22 20 L78 82", "M80 20 L24 80"];
  if (mark === "sankaku") return ["M50 15 L87 80 L13 82 L52 13"];
  const pts: string[] = [];
  const push = (x: number, y: number) => pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  if (mark === "hanamaru") {
    // 中の渦巻き → 外の花びら
    for (let i = 0; i <= 60; i++) {
      const a = (i / 60) * Math.PI * 5 - 1.6;
      const r = 2 + (i / 60) * 19;
      push(50 + Math.cos(a) * r, 50 + Math.sin(a) * r);
    }
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2 + 1.55;
      const r = 30 + 8 * Math.abs(Math.sin((i / 96) * Math.PI * 7));
      push(50 + Math.cos(a) * r, 50 + Math.sin(a) * r);
    }
  } else {
    // 手で描いた丸。少しゆがませ、終わりを少し重ねる
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2.12 - 1.9;
      const r = 35 + Math.sin(i * 0.5) * 1.6 - i * 0.05;
      push(50 + Math.cos(a) * r * 1.02, 50 + Math.sin(a) * r * 0.96);
    }
  }
  return [`M${pts.join(" L")}`];
}

const STROKES: Record<Mark, string[]> = {
  batsu: strokes("batsu"),
  sankaku: strokes("sankaku"),
  maru: strokes("maru"),
  hanamaru: strokes("hanamaru"),
};
const MARK_NAME: Record<Mark, string> = {
  batsu: "ばつ",
  sankaku: "さんかく",
  maru: "まる",
  hanamaru: "はなまる",
};

export function MarkSvg({ mark }: { mark: Mark }) {
  return (
    <svg
      className="dr-mark"
      data-mark={mark}
      viewBox="0 0 100 100"
      role="img"
      aria-label={MARK_NAME[mark]}
    >
      {STROKES[mark].map((d) => (
        <path key={d} pathLength={1} d={d} />
      ))}
    </svg>
  );
}

const ICON: Record<"tap" | "hold" | "swipe" | "drag", ReactNode> = {
  tap: (
    <>
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
      <circle cx="12" cy="12" r="8.5" />
    </>
  ),
  hold: (
    <>
      <circle cx="12" cy="12" r="6" fill="currentColor" />
      <path d="M12 2.5a9.5 9.5 0 1 1-9.5 9.5" />
    </>
  ),
  swipe: <path d="M3 12h17M14 6l6 6-6 6" />,
  drag: (
    <>
      <circle cx="18" cy="8" r="3.2" fill="currentColor" />
      <path d="M3 17c3-6 5 4 8-1s2-5 4-6" />
    </>
  ),
};

function InputIcon({ kind }: { kind: InputKind }) {
  const shape = kind in ICON ? ICON[kind as keyof typeof ICON] : null;
  if (!shape) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shape}
    </svg>
  );
}

/* ---------- 綴じ目（hd#A.3） ---------- */

/** 綴じ目。ランの中では手番・周回・残機、外では題字とランの種類 */
export function Binding(props: {
  /** ランの中なら、何問目か（1 始まり）。外なら null */
  turn: number | null;
  /** 周回（0 始まり）。2 周目から出す */
  lap: number;
  /** 残機。デイリーとランの外は null */
  lives: number | null;
}) {
  const { turn, lap, lives } = props;
  if (turn === null) {
    return (
      <header className="dr-binding">
        <span>GameFeed</span>
        <span>エンドレス</span>
        <span />
      </header>
    );
  }
  const left = lives === null ? 0 : Math.max(0, Math.min(ENDLESS_LIVES, lives));
  return (
    <header className="dr-binding">
      <span>{turnLabel(turn)}</span>
      <span>{lapLabel(lap) ?? ""}</span>
      {lives === null ? (
        <span />
      ) : (
        <span className="dr-lives" role="img" aria-label={`のこり ${left}`}>
          {Array.from({ length: ENDLESS_LIVES }, (_, i) => (
            <i key={i} className="dr-life" data-on={i < left ? "" : undefined} />
          ))}
        </span>
      )}
    </header>
  );
}

/* ---------- 紙 ---------- */

/** 紙に載せる知らせ（読み込み中、エラーなど） */
export function Notice({ children }: { children: ReactNode }) {
  return <div className="dr-page dr-squared">{children}</div>;
}

/** 表紙（hd#A.4）。全面がボタン。`onStart` が無い間は押せない */
export function Cover(props: { onStart: (() => void) | null; waiting: string | null }) {
  const { onStart, waiting } = props;
  return (
    <button type="button" className="dr-cover" disabled={!onStart} onClick={onStart ?? undefined}>
      <span className="dr-title">GameFeed</span>
      <span className="dr-band">エンドレス ドリル　ぜんぶで {ENDLESS_TURN_LIMIT} 問</span>
      {onStart ? <span className="dr-go">はじめる</span> : <span>{waiting}</span>}
    </button>
  );
}

/**
 * 問題のページ（幕間。hd#A.5）。出す文字は、手番の番号・動詞・入力・周回だけ。
 * 新作かどうかは受け取らない（知らせない。run#B.6）
 */
export function QuestionPage(props: {
  turn: number;
  /** まだ `ready` が届いていなければ null */
  meta: { verb: string; input: InputKind } | null;
  lap: number;
  /** 「続きから」の幕間（run#A.9） */
  resuming?: boolean;
}) {
  const { turn, meta, lap, resuming } = props;
  const lapText = lapLabel(lap);
  return (
    <div className="dr-page dr-squared">
      <span className="dr-scorebox" aria-hidden="true">
        点
      </span>
      <p className="dr-no">{turnLabel(turn)}</p>
      {resuming && <p className="dr-onpaper">続きから</p>}
      <p className="dr-verb">{meta?.verb ?? "…"}</p>
      {meta && !resuming && (
        <p className="dr-how">
          <InputIcon kind={meta.input} />
          <span>{inputLabel(meta.input)}</span>
        </p>
      )}
      {lapText && <p className="dr-onpaper">{lapText}</p>}
      <span className="dr-pageno" aria-hidden="true">
        <span className="dr-onpaper">— {turn} —</span>
      </span>
    </div>
  );
}

/** 採点（結果フラッシュ。hd#A.6）。ゲームの最後の画面の上に、紙の色の幕と赤ペン */
export function Grading({ flash }: { flash: FlashView | null }) {
  if (!flash) return <div className="dr-page dr-veil dr-grading" />;
  const text = flashText(flash);
  const mark = flashMark(flash);
  const points = flash.via === "guest" ? (flash.score ?? 0) : null;
  return (
    <div className="dr-page dr-veil dr-grading">
      {mark && <MarkSvg mark={mark} />}
      <p className="dr-points">
        {points === null ? "—" : points}
        {points !== null && <small>点</small>}
      </p>
      {/* 応答が届く前と後で高さが変わらないよう、行は常に置く */}
      <p className="dr-sub">{text.sub ?? ""}</p>
      {text.miss && <p className="dr-miss">ミス</p>}
    </div>
  );
}

/** 「おわり」の判子（hd#A.8）。ゲームの最後の画面の上に、紙の色の幕と丸い判子 */
export function EndStamp(props: { word: string; children?: ReactNode }) {
  return (
    <div className="dr-page dr-veil">
      <p className="dr-stamp dr-stamp-round">{props.word}</p>
      {props.children}
    </div>
  );
}

/** 成績表（hd#A.8）。項目は run#A.11 のとおりで、`reportView` が組んだ値を描くだけ */
export function ReportPage(props: { report: ReportView; children?: ReactNode }) {
  const r = props.report;
  // 「23 本」の数字だけを大きく書く
  const head = /^(\d+) (.+)$/.exec(r.heading);
  return (
    <div className="dr-page dr-report">
      <div className="dr-report-head">
        <p className="dr-kicker">エンドレス・{r.status}</p>
        <p className="dr-reached">
          {head ? head[1] : r.heading}
          {head && <small>{head[2]}</small>}
        </p>
        <p>{r.overall}</p>
        {r.stamp && <p className="dr-stamp">{r.stamp}</p>}
      </div>
      {r.notice && <p className="dr-warn">{r.notice}</p>}
      <ol className="dr-rows">
        {r.rows.map((row) => (
          <li key={row.no}>
            <span className="dr-row-no">{row.no}</span>
            <span className="dr-row-title">
              {row.title ?? "—"}
              {row.speed && <small>{row.speed}</small>}
            </span>
            <span className="dr-row-value">
              {row.note && <small>{row.note}</small>}
              {row.value}
            </span>
            <span className="dr-row-mark">{row.mark ? <MarkSvg mark={row.mark} /> : "—"}</span>
          </li>
        ))}
      </ol>
      <div className="dr-actions">{props.children}</div>
    </div>
  );
}
