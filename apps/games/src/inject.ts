// SDK を配信時に <head> の先頭へ入れる（gc#A.4）。ゲームのスクリプトより先に動かすため、開始タグの直後に置く。

const HEAD = /<head(?:\s[^>]*)?>/i;
const HTML = /<html(?:\s[^>]*)?>/i;
const DOCTYPE = /<!doctype[^>]*>/i;

/** インラインの <script> の中で、スクリプトが途中で閉じたりコメント扱いになったりしないようにする。 */
function escapeInline(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/**
 * `<head>` の開始タグの直後に `<script>SDK</script>` を入れる。
 * `<head>` がなければ `<html>` の直後、それもなければ doctype の直後、何もなければ先頭。
 * 文字列として最初に見つかった位置に入れる（HTML の構文解析はしない）。位置がずれても困るのはそのゲームだけ。
 */
export function injectSdk(html: string, sdkJs: string): string {
  const tag = `<script>${escapeInline(sdkJs)}</script>`;
  for (const re of [HEAD, HTML, DOCTYPE]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}
