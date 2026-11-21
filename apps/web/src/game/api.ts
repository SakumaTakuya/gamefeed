// ゲームページが読む `GET /api/posts/{id}`（公開済みの投稿。mo#A.3、mc#A.9）。匿名で呼ぶ。
// いいね（`PUT /api/posts/{id}/like`）は端末の主体で送る（`X-Device-Id`。product#3 の 5）。
// 応答はサーバのものでも形を確かめてから使う（古いデプロイや途中のプロキシの応答で画面を壊さない）。
import { DEVICE_ID_HEADER } from "../run/device-id.ts";

export interface PostInfo {
  postId: string;
  title: string;
  /** 作者の handle（mc#A.5） */
  handle: string;
  /** この端末がいいね済みか */
  liked: boolean;
}

export type PostLookup =
  | { kind: "found"; post: PostInfo }
  /** 見られない投稿。理由は区別されない（mo#A.3） */
  | { kind: "not_found" }
  /** 分からない（通信の失敗、5xx、形の違う応答）。遊ぶのは止めない */
  | { kind: "unknown" };

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

export function readPostLookup(status: number, body: unknown): PostLookup {
  if (!isObject(body)) return { kind: "unknown" };
  if (status === 404 && body.error === "not_found") return { kind: "not_found" };
  if (status !== 200) return { kind: "unknown" };
  const { post_id, title, author } = body;
  if (typeof post_id !== "string" || typeof title !== "string") return { kind: "unknown" };
  if (!isObject(author) || typeof author.handle !== "string") return { kind: "unknown" };
  return {
    kind: "found",
    post: { postId: post_id, title, handle: author.handle, liked: body.liked === true },
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
