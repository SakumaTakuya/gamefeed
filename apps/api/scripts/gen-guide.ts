import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildStyleCards, extractGuide, extractStyleRows } from "../src/guide.ts";

/**
 * `docs/game-contract.md` の A 部を `src/guide.gen.ts` に（mc#A.3 の `gf://guide`）、
 * A.14 の表にある画風カード `docs/styles/<id>.md` を `src/styles.gen.ts` に取り込む（`gf://style/<id>`）。
 * game-contract.md の A 部か docs/styles/ を直したら `pnpm --filter @gamefeed/api gen:guide` を実行してコミットする。
 * 忘れると `test/guide.spec.ts` が落ちる。
 */
const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const guide = extractGuide(readFileSync(path("../../../docs/game-contract.md"), "utf8"));
const guideOut = path("../src/guide.gen.ts");
writeFileSync(
  guideOut,
  `// 生成物。直接編集しない。元は docs/game-contract.md の A 部（scripts/gen-guide.ts）。\nexport const GUIDE_MARKDOWN: string = ${JSON.stringify(guide)};\n`,
);
console.log(`wrote ${guideOut}`);

const stylesDir = path("../../../docs/styles/");
const files = Object.fromEntries(
  readdirSync(stylesDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => [name.slice(0, -3), readFileSync(`${stylesDir}${name}`, "utf8")]),
);
const cards = buildStyleCards(extractStyleRows(guide), files);
const stylesOut = path("../src/styles.gen.ts");
writeFileSync(
  stylesOut,
  `// 生成物。直接編集しない。元は docs/game-contract.md の A.14 の表と docs/styles/*.md（scripts/gen-guide.ts）。\nimport type { StyleCard } from "./guide.ts";\n\nexport const STYLE_CARDS: readonly StyleCard[] = ${JSON.stringify(cards, null, 2)};\n`,
);
console.log(`wrote ${stylesOut}`);
