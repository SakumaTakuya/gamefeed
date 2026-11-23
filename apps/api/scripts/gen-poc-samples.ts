// fixtures/games/samples/*.html を apps/api/src/poc-samples.gen.ts に写す（PoC のまとめて投稿用。docs/poc.md）。
// サンプルを足した・直したら `pnpm --filter @gamefeed/api gen:poc-samples` を流す。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../../fixtures/games/samples/", import.meta.url));
const out = fileURLToPath(new URL("../src/poc-samples.gen.ts", import.meta.url));
const samples = readdirSync(dir)
  .filter((f) => f.endsWith(".html"))
  .sort()
  .map((f) => ({ name: f.replace(/\.html$/, ""), html: readFileSync(dir + f, "utf8") }));
writeFileSync(
  out,
  `// 生成物。手で直さない（scripts/gen-poc-samples.ts）\nexport const POC_SAMPLES: { name: string; html: string }[] = ${JSON.stringify(samples, null, 2)};\n`,
);
console.log(`${samples.length} 本を書いた`);
