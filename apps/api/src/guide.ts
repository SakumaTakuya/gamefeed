/**
 * リソース `gf://guide` の本文（mcp.md A.3）: `docs/game-contract.md` の A 部（A.1〜A.14）。
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

/** gc#A.14 の表の 1 行 */
export interface StyleRow {
  id: string;
  /** 画風の名前（「切り絵」など） */
  name: string;
  /** どんな絵か（表の 3 列目） */
  summary: string;
}

/** リソース `gf://style/<id>` の 1 枚（mcp.md A.3）。`markdown` は `docs/styles/<id>.md` の本文 */
export interface StyleCard extends StyleRow {
  markdown: string;
}

const STYLE_HEADING = "\n## A.14 ";
const STYLE_ROW = /^\| `([a-z][a-z0-9-]*)` \| ([^|\n]+) \| ([^|\n]+) \|$/gm;

/** A 部（`extractGuide` の結果）から A.14 の表を読む。A.14 や行が無ければ失敗する */
export function extractStyleRows(guide: string): StyleRow[] {
  const start = guide.indexOf(STYLE_HEADING);
  if (start < 0) throw new Error("extractStyleRows: 「## A.14 」が見つからない");
  const rest = guide.slice(start + 1);
  const next = rest.indexOf("\n## ");
  const section = next < 0 ? rest : rest.slice(0, next);
  const rows = [...section.matchAll(STYLE_ROW)].map((m) => ({
    id: m[1] as string,
    name: (m[2] as string).trim(),
    summary: (m[3] as string).trim(),
  }));
  if (rows.length === 0) throw new Error("extractStyleRows: A.14 に画風の表の行が無い");
  return rows;
}

/** 表の行と `docs/styles/` のファイル（id → 本文）を突き合わせる。1 対 1 でなければ失敗する */
export function buildStyleCards(rows: StyleRow[], files: Record<string, string>): StyleCard[] {
  const seen = new Set<string>();
  const cards = rows.map((row) => {
    if (seen.has(row.id)) throw new Error(`buildStyleCards: 表に ${row.id} が 2 回ある`);
    seen.add(row.id);
    const markdown = files[row.id];
    if (markdown === undefined) {
      throw new Error(`buildStyleCards: docs/styles/${row.id}.md が無い`);
    }
    return { ...row, markdown };
  });
  for (const id of Object.keys(files)) {
    if (!seen.has(id)) throw new Error(`buildStyleCards: docs/styles/${id}.md が A.14 の表に無い`);
  }
  return cards;
}

export function styleUri(id: string): string {
  return `gf://style/${id}`;
}

/** mc#A.4 の説明文（暫定） */
export function styleDescription(row: StyleRow): string {
  return `画風カード「${row.name}」。${row.summary}。配色・決まり・描き方のコード。カードは参考で、題材に合うときに、絵を描く前に読む。`;
}
