// ゲームページが読む `GET /api/posts/{id}`（公開済みの投稿。mo#A.3、mc#A.9）。匿名で呼ぶ。
// いいね（`PUT /api/posts/{id}/like`）は端末の主体で送る（`X-Device-Id`。product#3 の 5）。
// プレイ数・いいね数は同じ応答の `stats`、「今の偏差値」は `GET /api/posts/{id}/deviation`（product#5.3。校正済みだけ）。
// 応答はサーバのものでも形を確かめてから使う（古いデプロイや途中のプロキシの応答で画面を壊さない）。
import type { HistogramBin } from "@gamefeed/domain";
import { DEVICE_ID_HEADER } from "../run/device-id.ts";

export interface PostInfo {
  postId: string;
  title: string;
  /** 作者の handle（mc#A.5） */
  handle: string;
  /** この端末がいいね済みか */
  liked: boolean;
  /** プレイ数といいね数。校正済みの投稿だけ（product#9 の 5）。それ以外・読めないときは null */
  stats: PostStats | null;
}

export interface PostStats {
  plays: number;
  likes: number;
  /** 点数の分布の区間（domain の `histogram`）。無い・読めないときは空（図を出さない） */
  histogram: HistogramBin[];
}

/** これより多い区間は描かない（サーバは 12 本まで。形の違う応答で画面を埋めない） */
const HISTOGRAM_READ_MAX = 64;

export type PostLookup =
  | { kind: "found"; post: PostInfo }
  /** 見られない投稿。理由は区別されない（mo#A.3） */
  | { kind: "not_found" }
  /** 分からない（通信の失敗、5xx、形の違う応答）。遊ぶのは止めない */
  | { kind: "unknown" };

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

/** 形が違えば「出さない」。数が読めないだけで投稿を「分からない」にはしない */
function readStats(x: unknown): PostStats | null {
  if (!isObject(x) || !isCount(x.plays) || !isCount(x.likes)) return null;
  return { plays: x.plays, likes: x.likes, histogram: readHistogram(x.histogram) };
}

/** 区間は整数で、前から順につながらなくても重ならずに並ぶこと。1 つでも形が違えば全部捨てる */
function readHistogram(x: unknown): HistogramBin[] {
  if (!Array.isArray(x) || x.length > HISTOGRAM_READ_MAX) return [];
  const bins: HistogramBin[] = [];
  for (const b of x) {
    if (!isObject(b)) return [];
    const { from, to, count } = b;
    if (!isCount(from) || !isCount(to) || !isCount(count) || from > to) return [];
    const prev = bins[bins.length - 1];
    if (prev && from <= prev.to) return [];
    bins.push({ from, to, count });
  }
  return bins;
}

export function readPostLookup(status: number, body: unknown): PostLookup {
  if (!isObject(body)) return { kind: "unknown" };
  if (status === 404 && body.error === "not_found") return { kind: "not_found" };
  if (status !== 200) return { kind: "unknown" };
  const { post_id, title, author } = body;
  if (typeof post_id !== "string" || typeof title !== "string") return { kind: "unknown" };
  if (!isObject(author) || typeof author.handle !== "string") return { kind: "unknown" };
  return {
    kind: "found",
    post: {
      postId: post_id,
      title,
      handle: author.handle,
      liked: body.liked === true,
      stats: readStats(body.stats),
    },
  };
}

/** @param device 端末の `device_id`。付けると、その端末がいいね済みかが返る */
export async function fetchPost(postId: string, device: string): Promise<PostLookup> {
  try {
    const res = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
      headers: { accept: "application/json", [DEVICE_ID_HEADER]: device },
    });
    return readPostLookup(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "unknown" };
  }
}

/** `PUT /api/posts/{id}/like` の応答。200 の `{liked: true}` だけが成功 */
export function readLiked(status: number, body: unknown): boolean {
  return status === 200 && isObject(body) && body.liked === true;
}

/** いいねを送る。冪等（1 投稿につき 1 主体 1 回）。届かなければ false */
export async function sendLike(postId: string, device: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/like`, {
      method: "PUT",
      headers: { accept: "application/json", [DEVICE_ID_HEADER]: device },
    });
    return readLiked(res.status, await res.json().catch(() => null));
  } catch {
    return false;
  }
}

/** `GET /api/posts/{id}/deviation` の応答。200 の `{deviation: 数}` だけが値。それ以外は「出さない」 */
export function readDeviation(status: number, body: unknown): number | null {
  if (status !== 200 || !isObject(body)) return null;
  const { deviation } = body;
  return typeof deviation === "number" && Number.isFinite(deviation) ? deviation : null;
}

/** score の「今の偏差値」を読む。校正済みでない・届かないときは null（結果の幕は点数だけになる） */
export async function fetchDeviation(postId: string, score: number): Promise<number | null> {
  try {
    const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/deviation?score=${score}`, {
      headers: { accept: "application/json" },
    });
    return readDeviation(res.status, await res.json().catch(() => null));
  } catch {
    return null;
  }
}
