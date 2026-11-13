import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Guest SDK を 1 本の IIFE にする。出力は esbuild のバージョンと入力だけで決まる。 */
export async function buildGuestBundle(): Promise<string> {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("../src/guest-entry.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: true,
    legalComments: "none",
    charset: "ascii",
    write: false,
    logLevel: "silent",
  });
  const js = out.outputFiles[0]?.text;
  if (!js) throw new Error("Guest SDK のバンドルに失敗した");
  return js.trim();
}

export const GEN_PATH = fileURLToPath(new URL("../src/guest-bundle.gen.ts", import.meta.url));

export function genSource(js: string): string {
  return `// 生成物。直接編集しない。元は src/guest-entry.ts（scripts/gen-guest-bundle.ts）。\nexport const GUEST_SDK_JS: string = ${JSON.stringify(js)};\n`;
}
