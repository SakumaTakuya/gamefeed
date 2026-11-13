// Miniflare で配信 Worker を起動する（docs/testing.md: apps/games は Worker + R2 + KV の integration）。
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GUEST_SDK_JS } from "@gamefeed/sdk/guest-bundle";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { injectSdk } from "../../src/inject.ts";

export const GAMES_ORIGIN = "https://gamefeed-games.example.workers.dev";
export const APP_ORIGIN = "https://app.example";
export const SECRET = "test-signing-secret";

export const POST_A = "01M782MV00TMYMTHTGG5C6KS3T";
export const POST_B = "01M782MV00TMYMTHTGG5C6KS3V";
export const HASH_A = "a".repeat(64);
export const HTML_A =
  "<!doctype html><html><head><title>A</title></head><body><script>GF.onInit(()=>{})</script></body></html>";
/** 配信される形（SDK を <head> の先頭に入れたもの。gc#A.4） */
export const SERVED_A = injectSdk(HTML_A, GUEST_SDK_JS);

export type ServeStatus = "draft" | "ok" | "no";

export interface Harness {
  get(path: string, init?: RequestInit): Promise<Response>;
  putServe(postId: string, value: unknown): Promise<void>;
  putGame(hash: string, html: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function startWorker(): Promise<Harness> {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const script = out.outputFiles[0]?.text;
  if (!script) throw new Error("Worker のビルドに失敗した");
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-01",
    kvNamespaces: ["SERVE"],
    r2Buckets: ["GAMES"],
    bindings: { GAMES_SIGNING_SECRET: SECRET, APP_ORIGIN },
  });
  const kv = await mf.getKVNamespace("SERVE");
  const r2 = await mf.getR2Bucket("GAMES");
  return {
    // リダイレクトを追わない（R-5.3-4 で 3xx が返らないことを見るため）
    get: async (path, init) =>
      (await mf.dispatchFetch(`${GAMES_ORIGIN}${path}`, {
        redirect: "manual",
        ...init,
      } as never)) as unknown as Response,
    putServe: (postId, value) =>
      kv.put(`serve:${postId}`, typeof value === "string" ? value : JSON.stringify(value)),
    putGame: async (hash, html) => {
      await r2.put(`games/${hash}.html`, html);
    },
    dispose: () => mf.dispose(),
  };
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** se#A.5 の形をテスト側で独立に組み立てる（Worker の実装を使わない）。exp は Unix 秒。 */
export function playToken(postId: string, exp: number, secret: string = SECRET): string {
  const payload = `${postId}.${exp}`;
  return `${b64url(payload)}.${b64url(createHmac("sha256", secret).update(payload).digest())}`;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
