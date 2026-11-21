// ゲームページの通報（moderation.md A.4、run.md A.14）。カテゴリの表示名、送る前の検査、送信。
// 匿名でも送れる。主体は端末の `X-Device-Id`（product#3 の 5）。
import {
  parseReportInput,
  REPORT_CATEGORIES,
  REPORT_COMMENT_MAX,
  type ReportCategory,
  type ReportInput,
} from "@gamefeed/domain";
import { DEVICE_ID_HEADER } from "../run/device-id.ts";

/** カテゴリの表示名（mo#A.4 の表の「意味」を、遊ぶ人の言葉にしたもの） */
const LABELS: Record<ReportCategory, string> = {
  sexual: "性的",
  flashing: "光の点滅がきつい",
  violence: "暴力・グロ",
  hate: "差別・中傷",
  copyright: "著作権・他人の作品",
  loud: "音が大きい・不快",
  spam: "スパム・無内容・宣伝",
  broken: "動作しない",
  other: "その他",
};

export const REPORT_OPTIONS: readonly { category: ReportCategory; label: string }[] =
  REPORT_CATEGORIES.map((category) => ({ category, label: LABELS[category] }));

export type ReportDraft =
  | { ok: true; left: number; input: ReportInput }
  /** カテゴリが未選択か、コメントが長すぎる */
  | { ok: false; left: number };

/**
 * 送る前の検査。サーバと同じ `parseReportInput` を使う。
 * @returns `left` はコメントの残り文字数（負なら超過）
 */
export function reportDraft(category: ReportCategory | null, comment: string): ReportDraft {
  const left = REPORT_COMMENT_MAX - [...comment.trim()].length;
  const parsed = category ? parseReportInput({ category, comment }) : null;
  return parsed ? { ok: true, left, input: parsed } : { ok: false, left };
}

/**
 * - `reported`: 受け付けた（2 回目も同じ。mo#A.4）
 * - `own`: 自分の投稿（400 `invalid`）
 * - `failed`: 届かなかった・受け付けられなかった。もう一度送れる
 */
export type ReportResult = "reported" | "own" | "failed";

export function readReportResult(status: number, body: unknown): ReportResult {
  if (typeof body !== "object" || body === null) return "failed";
  const b = body as { reported?: unknown; error?: unknown };
  if (status === 200 && b.reported === true) return "reported";
  if (status === 400 && b.error === "invalid") return "own";
  return "failed";
}

export async function sendReport(
  postId: string,
  device: string,
  report: ReportInput,
): Promise<ReportResult> {
  try {
    const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/reports`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [DEVICE_ID_HEADER]: device,
      },
      body: JSON.stringify(report),
    });
    return readReportResult(res.status, await res.json().catch(() => null));
  } catch {
    return "failed";
  }
}
