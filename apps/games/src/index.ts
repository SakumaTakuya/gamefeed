// ゲーム HTML を投稿ごとのパス（/p/<post_id>/）から配信し、CSP（sandbox allow-scripts を含む）を付ける（spec#5.1, 5.3）。
// 実装は plan#2（W2）。ここでは Worker が起動することだけ保証する。
export interface Env {
  GAMES: R2Bucket;
}

export const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors https://*.gamefeed.example";

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("not found", { status: 404, headers: { "content-security-policy": CSP } });
  },
};
