import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApiBundle } from "../scripts/build.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// Vercel に載るのと同じ形（api/index.js + apps/api/dist/app.js）をリポジトリ外に置き、
// node_modules のない場所で別プロセスから読む。#17 の 2 つの原因をここで押さえる。
//   1. 関数バンドルから workspace / hono が解決できない
//   2. default export が関数だと @vercel/node が Node の (req, res) として呼ぶ
const probe = `
const mod = await import("./api/index.js");
const handler = mod.default;
const isWebHandler = typeof handler === "object" && handler !== null && typeof handler.fetch === "function";
const res = isWebHandler ? await handler.fetch(new Request("https://example.test/api/health")) : null;
console.log(JSON.stringify({ isWebHandler, status: res?.status ?? null, body: res ? await res.json() : null }));
`;

describe("Vercel 関数エントリ api/index.js (#17)", () => {
  let dir: string;
  let result: { isWebHandler: boolean; status: number | null; body: unknown };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gamefeed-vercel-"));
    await buildApiBundle(join(dir, "apps/api/dist/app.js"));
    await cp(join(repoRoot, "api"), join(dir, "api"), { recursive: true });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", probe],
      { cwd: dir },
    );
    result = JSON.parse(stdout);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("node_modules のない場所で読み込め、default export が fetch を持つ", () => {
    expect(result.isWebHandler).toBe(true);
  });

  it("GET /api/health が 200 と ok:true を返す", () => {
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, service: "gamefeed-api" });
  });
});
