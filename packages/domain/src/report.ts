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
  const trimmed = comment.trim();
  if ([...trimmed].length > REPORT_COMMENT_MAX) return null;
  return { category: category as ReportCategory, comment: trimmed === "" ? null : trimmed };
}
