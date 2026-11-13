// 配信レスポンスのヘッダ（se#A.4）。`<post_id>` だけを差し替えた同一形で、全レスポンスに付ける。

/** 投稿ごとの CSP。各ソースは自投稿のパスと /lib/ だけを指す（他の投稿のパスを含めない）。 */
export function cspForPost(
  gamesOrigin: string,
  appOrigin: string | undefined,
  postId: string,
): string {
  const post = `${gamesOrigin}/p/${postId}/`;
  const assets = `${post}assets/`;
  const lib = `${gamesOrigin}/lib/`;
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${post} ${lib}`,
    "style-src 'unsafe-inline'",
    `img-src ${assets} blob:`,
    `media-src ${assets} blob:`,
    `font-src ${assets}`,
    `connect-src ${assets} ${lib}`,
    "worker-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // APP_ORIGIN が未設定なら、どこにも埋め込ませない（緩い側に倒さない）
    `frame-ancestors ${appOrigin || "'none'"}`,
  ].join("; ");
}

/** 投稿 ID を含まないパス（/、/p/ の形式外など）の 404 用。何も読めず、スクリプトも動かない。 */
export const CSP_LOCKED =
  "sandbox; default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** CSP 以外の共通ヘッダ。Set-Cookie は返さない（se#A.2）。 */
export function baseHeaders(csp: string): Headers {
  return new Headers({
    "content-security-policy": csp,
    "cross-origin-resource-policy": "cross-origin",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}
