// ラン画面に出す文字の組み立て（run#A.5、A.7、A.10、A.11）。
// Host は成績を計算しない。サーバの値と Host の進行（残機、ミス）を文字にするだけ。
import { ENDLESS_LIVES, type InputKind } from "@gamefeed/domain";
import type { RunReport } from "./api.ts";
import type { FlashView } from "./controller.ts";

/** 幕間に出す入力の種類（run#A.5 の 4。アイコンの代わりの文字。絵は見た目を決めるときに入れる） */
const INPUT_LABEL: Record<InputKind, string> = {
  tap: "タップ",
  hold: "長押し",
  swipe: "スワイプ",
  drag: "ドラッグ",
  stick: "スティック",
  tilt: "傾ける",
};
export const inputLabel = (kind: InputKind): string => INPUT_LABEL[kind];

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/** 結果フラッシュ（run#A.5 の 2）。sub は応答が届いたら足される */
export function flashText(f: FlashView): { main: string; sub: string | null; miss: boolean } {
  if (f.via === "timeout") return { main: "—", sub: "時間切れ（成績に入りません）", miss: false };
  if (f.via === "error") return { main: "—", sub: "エラー（成績に入りません）", miss: false };
  const main = `${f.score ?? 0} 点`;
  if (f.deviation !== null) return { main, sub: `偏差値 ${f.deviation.toFixed(1)}`, miss: f.miss };
  // 偏差値の代わりに目標との比を出し、「校正中」と添える（run#A.10）
  if (f.ratio !== null) return { main, sub: `校正中 ${percent(f.ratio)}`, miss: f.miss };
  return { main, sub: f.isNew ? "校正中" : null, miss: f.miss };
}

/** 残機（エンドレス）。デイリーは残機が無いので空 */
export function livesText(lives: number | null): string {
  if (lives === null) return "";
  const left = Math.max(0, Math.min(ENDLESS_LIVES, lives));
  return "♥".repeat(left) + "♡".repeat(ENDLESS_LIVES - left);
}

export interface ReportRow {
  /** 何本目か（1 始まり） */
  no: number;
  /** ゲームの題名。この端末で `ready` を受けていなければ null */
  title: string | null;
  /** 偏差値、校正中の比、skip の「—」 */
  value: string;
  note: string | null;
  miss: boolean;
  /** 等速より速い手番の倍率 */
  speed: string | null;
}

export interface ReportView {
  heading: string;
  status: string;
  overall: string;
  rows: ReportRow[];
  /** 記録に入らなかった手番の知らせ（run#A.7） */
  notice: string | null;
}

const STATUS: Record<RunReport["ended"], string> = {
  lives: "終了",
  limit: "完走",
  abandoned: "中断",
  error: "通信エラー",
};

/** 成績表（run#A.11 のエンドレスの列）。`finish` が返した値を描くだけ */
export function reportView(
  report: RunReport,
  opts: { unsettled: number; titles: Readonly<Record<string, { title: string }>> },
): ReportView {
  return {
    heading: `${report.reached} 本`,
    status: STATUS[report.ended],
    overall:
      report.avg_deviation === null
        ? "総合偏差値 —"
        : `総合偏差値 ${report.avg_deviation.toFixed(1)}（参考）`,
    notice: opts.unsettled > 0 ? `通信できなかった ${opts.unsettled} 本は記録されていません` : null,
    rows: report.turns.map((t) => {
      const scored = t.kind !== "skip";
      const ratio = scored && t.deviation === null && t.ratio !== null;
      return {
        no: t.turn + 1,
        title: opts.titles[t.post_id]?.title ?? null,
        value: !scored
          ? "—"
          : t.deviation !== null
            ? t.deviation.toFixed(1)
            : t.ratio !== null
              ? percent(t.ratio)
              : "—",
        note: ratio ? "校正中" : null,
        miss: t.kind === "miss",
        speed: t.speed > 1 ? `×${t.speed}` : null,
      };
    }),
  };
}
