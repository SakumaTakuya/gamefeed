/**
 * リソース `gf://guide` の本文（mcp.md A.3）: `docs/game-contract.md` の A 部（A.1〜A.13）。
 * `scripts/gen-guide.ts` がこの関数で切り出して `guide.gen.ts` に書き、`test/guide.spec.ts` が文書とのずれを検出する。
 */

const A_HEADING = "# A. 規約";
const B_HEADING = /\n---\n+# B\. /;

/** A 部の見出しから、B 部の手前の区切り線の前までを返す。見出しが無ければ失敗する */
export function extractGuide(markdown: string): string {
  const start = markdown.indexOf(`${A_HEADING}\n`);
  if (start < 0) throw new Error("extractGuide: 「# A. 規約」が見つからない");
  const rest = markdown.slice(start);
  const end = rest.search(B_HEADING);
  if (end < 0) throw new Error("extractGuide: B 部（「---」の後の「# B. 」）が見つからない");
  return `${rest.slice(0, end).trimEnd()}\n`;
}
