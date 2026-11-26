import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blankCommentsAndStrings, staticCheck } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import { GUIDE_MARKDOWN } from "../src/guide.gen.ts";
import { buildStyleCards, extractGuide, extractStyleRows } from "../src/guide.ts";
import { STYLE_CARDS } from "../src/styles.gen.ts";

// mc#A.3: gf://guide は game-contract.md の A 部（A.1〜A.14）の本文
describe("R-mc.A3-1 gf://guide の本文", () => {
  const contract = readFileSync(
    fileURLToPath(new URL("../../../docs/game-contract.md", import.meta.url)),
    "utf8",
  );

  it("取り込み済みの本文（guide.gen.ts）はリポジトリの game-contract.md の A 部と一致する。ずれたら `pnpm --filter @gamefeed/api gen:guide`", () => {
    expect(GUIDE_MARKDOWN).toBe(extractGuide(contract));
  });

  it("A 部は「# A. 規約」から始まり、A.1〜A.14 を含み、B 部と区切り線を含まない", () => {
    const guide = extractGuide(contract);
    expect(guide.startsWith("# A. 規約\n")).toBe(true);
    for (let i = 1; i <= 14; i++) expect(guide).toContain(`\n## A.${i} `);
    expect(guide).not.toContain("# B.");
    expect(guide).not.toContain("## B.1");
    expect(guide.endsWith("\n")).toBe(true);
    expect(guide.trimEnd().endsWith("---")).toBe(false);
  });

  it("A 部や B 部の見出しがない文書は失敗する（黙って空を返さない）", () => {
    expect(() => extractGuide("# 何か\n\n本文\n")).toThrow();
    expect(() => extractGuide("# A. 規約\n\n本文だけで B 部がない\n")).toThrow();
  });
});

const stylesDir = fileURLToPath(new URL("../../../docs/styles/", import.meta.url));
const styleFiles = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(stylesDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => [name.slice(0, -3), readFileSync(`${stylesDir}${name}`, "utf8")]),
  );
const contractGuide = () =>
  extractGuide(
    readFileSync(fileURLToPath(new URL("../../../docs/game-contract.md", import.meta.url)), "utf8"),
  );

// mc#A.3: gf://style/<id> は docs/styles/<id>.md の本文。<id> は gc#A.14 の表にあるものだけ
describe("R-mc.A3-1 画風カードの取り込み", () => {
  it("取り込み済みのカード（styles.gen.ts）は gc#A.14 の表と docs/styles/ に一致する。ずれたら `pnpm --filter @gamefeed/api gen:guide`", () => {
    expect(STYLE_CARDS).toEqual(buildStyleCards(extractStyleRows(contractGuide()), styleFiles()));
  });

  it("gc#A.14 の表は id・画風・どんな絵か の 3 列で、最初の 4 枚は kirie / neon / kokuban / dot", () => {
    const rows = extractStyleRows(contractGuide());
    expect(rows.map((r) => r.id)).toEqual(["kirie", "neon", "kokuban", "dot"]);
    for (const row of rows) {
      expect(row.name).not.toBe("");
      expect(row.summary).not.toBe("");
    }
  });

  it("表の id と docs/styles/ のファイルは 1 対 1。片方にしか無ければ失敗する（黙って落とさない）", () => {
    const rows = [{ id: "a", name: "A", summary: "x" }];
    expect(() => buildStyleCards(rows, {})).toThrow(/a/);
    expect(() => buildStyleCards(rows, { a: "# a\n", b: "# b\n" })).toThrow(/b/);
    expect(() => buildStyleCards([...rows, ...rows], { a: "# a\n" })).toThrow(/a/);
    expect(buildStyleCards(rows, { a: "# a\n" })).toEqual([
      { id: "a", name: "A", summary: "x", markdown: "# a\n" },
    ]);
  });

  it("A.14 や表が無い文書は失敗する", () => {
    expect(() => extractStyleRows("# A. 規約\n\n## A.1 x\n")).toThrow();
    expect(() => extractStyleRows("# A. 規約\n\n## A.14 絵\n\n表が無い\n")).toThrow();
  });
});

// gc#A.14: カードのコードは、ゲームに写してそのまま規約を守る
describe("R-gc.A14-1 画風カードの描き方のコード", () => {
  const cards = Object.entries(styleFiles());
  const codeOf = (markdown: string) =>
    [...markdown.matchAll(/```javascript\n([\s\S]*?)```/g)].map((m) => m[1] as string);

  it.each(cards)(
    "%s は 配色・決まり・描き方・動き の節と、コードのブロックを 1 つ持つ",
    (_id, markdown) => {
      for (const heading of ["## 配色", "## 決まり", "## 描き方", "## 動き"]) {
        expect(markdown).toContain(`\n${heading}\n`);
      }
      expect(codeOf(markdown)).toHaveLength(1);
    },
  );

  it.each(cards)(
    "%s のコードを写したゲームは、静的検査を拒否も警告もなしで通る",
    (_id, markdown) => {
      const html = [
        "<!doctype html>",
        '<html lang="ja">',
        "<head>",
        '<meta charset="utf-8">',
        "<title>画風カードの検査</title>",
        '<meta name="gf:duration" content="300">',
        '<meta name="gf:verb" content="タップ！">',
        '<meta name="gf:input" content="tap">',
        '<meta name="gf:target" content="1">',
        "</head>",
        "<body>",
        '<canvas id="c"></canvas>',
        "<script>",
        "GF.onInit(() => { GF.score = 0; });",
        codeOf(markdown)[0],
        "</script>",
        "</body>",
        "</html>",
      ].join("\n");
      const result = staticCheck(html);
      expect(result.ok ? result.warnings : result.errors).toEqual([]);
    },
  );

  it.each(cards)(
    "%s のコードは GF.rng を呼ばず（絵で乱数を引くと点数が変わる）、構文として読める",
    (_id, markdown) => {
      const code = codeOf(markdown)[0] as string;
      expect(blankCommentsAndStrings(code)).not.toMatch(/GF\s*\.\s*rng/);
      expect(() => new Function(code)).not.toThrow();
    },
  );
});
