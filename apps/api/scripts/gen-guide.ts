import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractGuide } from "../src/guide.ts";

/**
 * `docs/game-contract.md` の A 部を `src/guide.gen.ts` に取り込む（mc#A.3 の `gf://guide`）。
 * game-contract.md の A 部を直したら `pnpm --filter @gamefeed/api gen:guide` を実行してコミットする。
 * 忘れると `test/guide.spec.ts` が落ちる。
 */
const contract = readFileSync(
  fileURLToPath(new URL("../../../docs/game-contract.md", import.meta.url)),
  "utf8",
);
const out = fileURLToPath(new URL("../src/guide.gen.ts", import.meta.url));
writeFileSync(
  out,
  `// 生成物。直接編集しない。元は docs/game-contract.md の A 部（scripts/gen-guide.ts）。\nexport const GUIDE_MARKDOWN: string = ${JSON.stringify(extractGuide(contract))};\n`,
);
console.log(`wrote ${out}`);
