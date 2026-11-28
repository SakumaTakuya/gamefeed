/**
 * 公開直後のジョブの本体（mcp.md A.9、scoring.md A.10）。DB だけに触る。
 * ブラウザでハーネスのページを開く部分は `scripts/post-publish.ts`（Playwright）にあり、ここには入れない
 * （API の束に Playwright を入れない）。Actions の `post-publish`（定期実行）から呼ぶ。
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { MANUAL_THUMB_KEY } from "./manual-thumb.ts";

/** 実行チェックに使う速度（sc#A.10）。等速の回でサムネを撮る */
export const CHECK_SPEEDS = [1, 1.5] as const;
/** サムネを撮る時点。`start` からの秒数（フレーム 90 ごろ。sc#A.10） */
export const THUMB_AFTER_SEC = 1.5;
/** 1 回のジョブで見る投稿の上限（暫定）。残りは次の回 */
export const BATCH_LIMIT = 20;

export const thumbKeyOf = (postId: string): string => `thumbs/${postId}.webp`;

/** ハーネスのページ（apps/web の `HarnessReport`）が `data-harness` に出す形。ここでは読むだけ */
export type HarnessReport =
  | { phase: "loading" | "ready" | "running" }
  | { phase: "done"; outcome: "ended"; score: number; frames: number }
  | {
      phase: "done";
      outcome: "timeout" | "error" | "no_ready" | "navigated" | "violation";
      detail: string | null;
    };

/** ハーネスを 1 回走らせた結果 */
export interface HarnessRun {
  speed: number;
  /** ゲームの HTML（配信オリジン）の応答の状態。届かなければ null */
  gameStatus: number | null;
  /** 最後に読めた報告。ページが開けなければ null */
  report: HarnessReport | null;
}

export type CheckOutcome =
  /** すべての速度で `end` が届いた */
  | { kind: "ok" }
  /** ゲームの側の問題（固まる、例外、`ready` が来ない、プロトコル違反）。`invalid` にする */
  | { kind: "broken"; reason: string }
  /** ゲームのせいと言えない（配信されない、開けない、時間内に終わらない）。次の回にやり直す */
  | { kind: "retry"; reason: string };

/** ハーネスの結果の扱い（sc#A.10 の表） */
export function judge(runs: readonly HarnessRun[]): CheckOutcome {
  for (const run of runs) {
    const at = `speed ${run.speed}`;
    const r = run.report;
    if (!r || r.phase !== "done") {
      // ゲームは配信されたのに、時間内に終わらない・ページが応答しなくなった。
      // Guest が Host と同じプロセスで動くと、固まったゲームは Host の監視タイマーごと止める（run.md の未解決）
      if (run.gameStatus === 200) {
        return { kind: "broken", reason: `${at}: 応答が止まった（${r?.phase ?? "読めない"}）` };
      }
      return { kind: "retry", reason: `${at}: ハーネスのページを読めない` };
    }
    if (r.outcome === "ended") continue;
    if (r.outcome === "no_ready" && run.gameStatus !== 200) {
      // 公開直後は KV の反映待ちで 404 になる（se#A.5）
      return {
        kind: "retry",
        reason: `${at}: ゲームが配信されない（${run.gameStatus ?? "応答なし"}）`,
      };
    }
    return { kind: "broken", reason: `${at}: ${r.outcome}${r.detail ? `（${r.detail}）` : ""}` };
  }
  if (runs.length < CHECK_SPEEDS.length)
    return { kind: "retry", reason: "全部の速度を走らせていない" };
  return { kind: "ok" };
}

export interface PendingPost {
  id: string;
  /** NULL か、目印 `manual` */
  thumbKey: string | null;
}

/**
 * ジョブの対象。公開中・未校正・`thumb_key` が NULL の投稿（公開の古い順）。
 * `redoManual`（R2 の鍵がある）なら、目印 `manual` の投稿も拾って画像を作る。
 */
export async function pendingPosts(
  db: Db,
  opts: { redoManual: boolean; limit?: number },
): Promise<PendingPost[]> {
  const rows = await db.execute<{ id: string; thumb_key: string | null }>(sql`
    select p.id, p.thumb_key
    from posts p join post_status ps on ps.id = p.id
    where ps.status in ('limited', 'public')
      and ((p.calibration = 'uncalibrated' and p.thumb_key is null)
        or (${opts.redoManual} and p.thumb_key = ${MANUAL_THUMB_KEY}
          and p.calibration in ('uncalibrated', 'calibrated')))
    order by p.published_at, p.id
    limit ${opts.limit ?? BATCH_LIMIT}`);
  return rows.map((r) => ({ id: r.id, thumbKey: r.thumb_key }));
}

export interface ThumbStorage {
  putThumb(key: string, webp: Uint8Array): Promise<void>;
}

/**
 * 結果を投稿に反映する。戻り値は、やったこと。
 * - `thumb`: 画像を保存して `thumb_key` を入れた
 * - `manual`: 画像なしで目印を入れた（R2 の鍵が無い、または撮れなかった）
 * - `invalid`: `calibration = invalid` にした
 * - `none`: 何も変えなかった
 * 公開をやめた投稿・もう本物のキーがある投稿は変えない。`invalid` にするのは `uncalibrated` だけ。
 */
export async function applyCheck(
  db: Db,
  postId: string,
  outcome: CheckOutcome,
  io: { thumb: Uint8Array | null; storage: ThumbStorage | null },
): Promise<"thumb" | "manual" | "invalid" | "none"> {
  if (outcome.kind === "retry") return "none";
  const published = sql`exists (
    select 1 from post_status ps where ps.id = posts.id and ps.status in ('limited', 'public'))`;
  if (outcome.kind === "broken") {
    const rows = await db.execute(sql`
      update posts set calibration = 'invalid'
      where id = ${postId} and calibration = 'uncalibrated' and ${published}
      returning id`);
    return rows.length > 0 ? "invalid" : "none";
  }
  if (io.thumb && io.storage) {
    const key = thumbKeyOf(postId);
    const [open] = await db.execute(sql`
      select 1 from posts
      where id = ${postId} and (thumb_key is null or thumb_key = ${MANUAL_THUMB_KEY}) and ${published}`);
    if (!open) return "none";
    // 先に置く。DB の更新に失敗しても、次の回が同じキーに上書きするだけ
    await io.storage.putThumb(key, io.thumb);
    const rows = await db.execute(sql`
      update posts set thumb_key = ${key}
      where id = ${postId} and (thumb_key is null or thumb_key = ${MANUAL_THUMB_KEY}) and ${published}
      returning id`);
    return rows.length > 0 ? "thumb" : "none";
  }
  const rows = await db.execute(sql`
    update posts set thumb_key = ${MANUAL_THUMB_KEY}
    where id = ${postId} and thumb_key is null and ${published}
    returning id`);
  return rows.length > 0 ? "manual" : "none";
}
