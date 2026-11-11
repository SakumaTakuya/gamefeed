/** game-contract.md A.3 を満たす最小の HTML。引数で meta と script を差し替える（テスト用）。 */
export function gameHtml(
  opts: {
    title?: string;
    duration?: string;
    head?: string;
    script?: string;
    /** 内容（= ハッシュ）を変えるためのコメント */
    salt?: string;
  } = {},
): string {
  return `<!doctype html><html><head><title>${opts.title ?? "まるタップ"}</title>
<meta name="gf:duration" content="${opts.duration ?? "300"}">
<meta name="gf:verb" content="タップ！">
<meta name="gf:input" content="tap">
<meta name="gf:target" content="12">
${opts.head ?? ""}
<style>body{margin:0}</style></head>
<body><div id="t"></div><!-- ${opts.salt ?? ""} -->
<script>${opts.script ?? "GF.onStart(() => {}); GF.onInput(() => { GF.score += 1; });"}</script>
</body></html>`;
}
