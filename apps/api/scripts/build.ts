import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Vercel の api/index.js から読む、依存（hono・workspace パッケージ）込みの 1 ファイルを作る。
 * workspace パッケージは exports が .ts ソースを指すため、@vercel/node のトレースに任せると
 * 関数バンドルから解決できない（#17）。ここで束ねて node_modules を不要にする。
 */
export async function buildApiBundle(outfile: string): Promise<void> {
  await build({
    entryPoints: [`${apiRoot}src/app.ts`],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildApiBundle(`${apiRoot}dist/app.js`);
}
