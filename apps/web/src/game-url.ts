// ゲーム URL の組み立てはこの 1 関数に閉じる（se#A.2、R-5.1-3）。
// 侵入テストの結果でサブドメイン方式へ戻すときは、ここと配信 Worker の設定だけを変える。

/** ULID（Crockford Base32、26 文字、大文字）。 */
const POST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * `<games-origin>/p/<post_id>/`。下書きの試遊は `?t=<試遊トークン>` を付ける（se#A.5）。
 * @param gamesOrigin 配信オリジン（`VITE_GAMES_ORIGIN`）。https のオリジンだけ（ローカルは http://localhost 可）
 */
export function gameUrl(gamesOrigin: string, postId: string, token?: string): string {
  let origin: URL;
  try {
    origin = new URL(gamesOrigin);
  } catch {
    throw new Error("配信オリジンが URL ではありません");
  }
  const local = origin.protocol === "http:" && origin.hostname === "localhost";
  if ((origin.protocol !== "https:" && !local) || origin.pathname !== "/" || origin.search) {
    throw new Error("配信オリジンは https のオリジンだけにしてください");
  }
  if (!POST_ID.test(postId)) throw new Error("post_id の形式が違います");
  const url = `${origin.origin}/p/${postId}/`;
  return token ? `${url}?t=${encodeURIComponent(token)}` : url;
}
