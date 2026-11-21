// 通報のカテゴリ・係数・重み・本文の検査（moderation.md A.4、A.9）。値はすべて暫定。

/** 通報のカテゴリ（mo#A.4） */
export const REPORT_CATEGORIES = [
  "sexual",
  "flashing",
  "violence",
  "hate",
  "copyright",
  "loud",
  "spam",
  "broken",
  "other",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * カテゴリ係数。`sexual` と `flashing` は遊ぶ側に即座の害があるので重く、
 * `broken` は校正の検査が結果から同じことを判定するので軽い（mo#A.4）。
 */
export const REPORT_COEF: Readonly<Record<ReportCategory, number>> = {
  sexual: 3,
  flashing: 3,
  violence: 1,
  hate: 1,
  copyright: 1,
  loud: 1,
  spam: 1,
  broken: 0.2,
  other: 1,
};

/** コメントの長さの上限（文字数。符号位置で数える） */
export const REPORT_COMMENT_MAX = 200;

/** 通報が運営に退けられた（`dismissed`）ときの、通報者の信頼スコアの変化（mo#A.5、A.9） */
export const TRUST_DELTA_REPORT_DISMISSED = -2;

/**
 * 通報の重み = 信頼係数 × カテゴリ係数。受付時に計算して `reports.weight` に凍結する（mo#A.4、B.7）。
 * @param trustScore 通報者の `users.trust_score`（0〜100）。匿名（`actors.user_id` が NULL）は null で、重み 0（I14）
 */
export function reportWeight(trustScore: number | null, category: ReportCategory): number {
  if (trustScore === null) return 0;
  return (trustScore / 10) * REPORT_COEF[category];
}

export interface ReportInput {
  category: ReportCategory;
  /** 前後の空白を落としたもの。無い・空なら null */
  comment: string | null;
}

/** `{category, comment?}` を確かめる。形が違えば null */
export function parseReportInput(body: unknown): ReportInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { category, comment } = body as { category?: unknown; comment?: unknown };
  if (typeof category !== "string") return null;
  if (!(REPORT_CATEGORIES as readonly string[]).includes(category)) return null;
  if (comment === undefined || comment === null) {
    return { category: category as ReportCategory, comment: null };
  }
  if (typeof comment !== "string") return null;
  // U+0000 は Postgres の text に入らない（挿入が失敗する）。受け付けない
  if (comment.includes("\u0000")) return null;
  const trimmed = comment.trim();
  if ([...trimmed].length > REPORT_COMMENT_MAX) return null;
  return { category: category as ReportCategory, comment: trimmed === "" ? null : trimmed };
}

/** 全カテゴリの `open` の通報の重みの合計がこれ以上で自動制限（mo#A.4、A.9。暫定） */
export const AUTO_RESTRICT_SUM = 10;
/** `sexual` / `flashing` だけの合計がこれ以上で自動制限（暫定） */
export const AUTO_RESTRICT_SEVERE = 5;

const SEVERE: readonly string[] = ["sexual", "flashing"] satisfies ReportCategory[];
/** 小数の足し算の誤差（0.2 を 50 回足すと 10 にわずかに届かない）で閾値を外さないための幅 */
const EPS = 1e-9;

/** 1 つの投稿の、`resolution = open` の通報のカテゴリごとの集計 */
export interface ReportTally {
  category: string;
  /** 重みの合計 */
  weight: number;
  /** 件数（重み 0 の匿名も含む） */
  count: number;
}

export interface AutoRestrictDecision {
  restrict: boolean;
  total: number;
  severe: number;
  /** `moderation_actions.reason` に書く内訳。運営の内部メモで、作者には返さない（mo#A.4） */
  reason: string;
}

const num = (x: number): string => String(Math.round(x * 100) / 100);

/**
 * 自動制限の判定（mo#A.4）。匿名の通報は重み 0 なので、何件あっても制限しない（M10）。
 * 判定は「人が見るまで隠す」ためのもので、通報の解決でも信頼スコアの変化でもない。
 */
export function autoRestrict(tallies: readonly ReportTally[]): AutoRestrictDecision {
  let total = 0;
  let severe = 0;
  for (const t of tallies) {
    total += t.weight;
    if (SEVERE.includes(t.category)) severe += t.weight;
  }
  const breakdown = [...tallies]
    .sort((a, b) => b.weight - a.weight || a.category.localeCompare(b.category))
    .map((t) => `${t.category} ${num(t.weight)}（${t.count} 件）`)
    .join("、");
  return {
    restrict: total >= AUTO_RESTRICT_SUM - EPS || severe >= AUTO_RESTRICT_SEVERE - EPS,
    total,
    severe,
    reason: `自動制限: 合計 ${num(total)}（閾値 ${AUTO_RESTRICT_SUM}）、sexual+flashing ${num(severe)}（閾値 ${AUTO_RESTRICT_SEVERE}）。内訳: ${breakdown}`,
  };
}
