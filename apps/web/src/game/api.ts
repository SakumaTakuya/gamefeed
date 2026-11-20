// ゲームページが読む `GET /api/posts/{id}`（公開済みの投稿。mo#A.3、mc#A.9）。匿名で呼ぶ。
// 応答はサーバのものでも形を確かめてから使う（古いデプロイや途中のプロキシの応答で画面を壊さない）。

export interface PostInfo {
  postId: string;
  title: string;
  /** 作者の handle（mc#A.5） */
  handle: string;
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
  return { kind: "found", post: { postId: post_id, title, handle: author.handle } };
}

export async function fetchPost(postId: string): Promise<PostLookup> {
  try {
    const res = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
      headers: { accept: "application/json" },
    });
    return readPostLookup(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "unknown" };
  }
}
