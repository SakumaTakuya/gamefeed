// ハーネスを実ブラウザで通す（sc#A.10。R-sc.A10-1 の e2e）。CI では回さない（手元で実行する）。
//
//   VITE_GAMES_ORIGIN=http://localhost:5301 pnpm --filter @gamefeed/web build
//   pnpm --filter @gamefeed/api harness:e2e
//
// アプリは `vite preview`（127.0.0.1:5300）、配信は本番と同じ Worker のハンドラ（apps/games）を Node の HTTP で包んで :5301 に立てる。
// R2 と KV だけメモリの代わりにする。CSP・sandbox・SDK の差し込みは本番のコードのまま。
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import worker from "../../../games/src/index.ts";
import { runHarness, toWebp } from "../../scripts/harness-browser.ts";
import { judge } from "../../src/post-publish.ts";

// アプリは 127.0.0.1、配信は localhost。別のサイトにする（本番も別のサイト）。APP_HOST=localhost で同じサイトにすると
// Guest が Host と同じプロセスになり、固まったゲームがページごと止める。どちらでも結果は broken になる。
// 配信を localhost にするのは、`gameUrl` が https 以外を localhost にだけ許すから
const APP_HOST = process.env.APP_HOST ?? "127.0.0.1";
const APP = `http://${APP_HOST}:5300`;
const GAMES_PORT = 5301;
const GAMES_HOST = "localhost";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const sample = readFileSync(`${root}fixtures/games/samples/catch.html`, "utf8");

const games: Record<string, string | null> = {
  // そのまま
  "01M782MV00TMYMTHTGG5C6KS3A": sample,
  // 30 フレーム目で固まる
  "01M782MV00TMYMTHTGG5C6KS3B": sample.replace(
    "GF.onTick((frame) => {",
    "GF.onTick((frame) => { if (frame === 30) for (;;) {}",
  ),
  // 30 フレーム目で例外
  "01M782MV00TMYMTHTGG5C6KS3C": sample.replace(
    "GF.onTick((frame) => {",
    'GF.onTick((frame) => { if (frame === 30) throw new Error("boom");',
  ),
  // 読み込みで固まる（ready が来ない）
  "01M782MV00TMYMTHTGG5C6KS3D": sample.replace("GF.onInit(", "for (;;) {}\nGF.onInit("),
  // 配信されない（KV に無い）
  "01M782MV00TMYMTHTGG5C6KS3E": null,
};
const hashOf = (html: string) => createHash("sha256").update(html).digest("hex");
const env = {
  APP_ORIGIN: APP,
  SERVE: {
    get: async (key: string) => {
      const html = games[key.replace("serve:", "")];
      return html ? JSON.stringify({ hash: hashOf(html), status: "ok" }) : null;
    },
  },
  GAMES: {
    get: async (key: string) => {
      const html = Object.values(games).find((h) => h && `games/${hashOf(h)}.html` === key);
      return html ? { text: async () => html } : null;
    },
  },
};

const server = createServer(async (req, res) => {
  const response = await worker.fetch(
    new Request(`http://${GAMES_HOST}:${GAMES_PORT}${req.url}`, { method: req.method ?? "GET" }),
    env as never,
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(GAMES_PORT);

const preview: ChildProcess = spawn(
  "pnpm",
  [
    "--filter",
    "@gamefeed/web",
    "exec",
    "vite",
    "preview",
    "--host",
    APP_HOST,
    "--port",
    "5300",
    "--strictPort",
  ],
  { cwd: root, stdio: "ignore", detached: true },
);

const expectations: Record<string, string> = {
  "01M782MV00TMYMTHTGG5C6KS3A": "ok",
  "01M782MV00TMYMTHTGG5C6KS3B": "broken",
  "01M782MV00TMYMTHTGG5C6KS3C": "broken",
  "01M782MV00TMYMTHTGG5C6KS3D": "broken",
  "01M782MV00TMYMTHTGG5C6KS3E": "retry",
};

let failed = 0;
const browser = await chromium.launch();
try {
  // preview が立つのを待つ
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(APP).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const [postId, want] of Object.entries(expectations)) {
    const runs = [];
    let png: Uint8Array | null = null;
    for (const speed of [1, 1.5]) {
      const t0 = Date.now();
      const shot = await runHarness(browser, { appOrigin: APP, postId, speed, shoot: speed === 1 });
      runs.push(shot);
      png ??= shot.png;
      console.log(
        `  ${postId.slice(-1)} speed ${speed}: status ${shot.gameStatus} ${JSON.stringify(shot.report)} ${Date.now() - t0}ms`,
      );
      if (shot.report?.phase !== "done" || shot.report.outcome !== "ended") break;
    }
    const got = judge(runs);
    const ok = got.kind === want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${postId}: ${JSON.stringify(got)}（期待 ${want}）`);
    if (want === "ok") {
      const webp = png ? await toWebp(browser, png) : null;
      const isWebp = webp !== null && Buffer.from(webp.slice(8, 12)).toString() === "WEBP";
      if (!isWebp) failed++;
      console.log(`${isWebp ? "PASS" : "FAIL"} サムネ: ${webp?.length ?? 0} バイトの WebP`);
      if (png && process.env.HARNESS_E2E_OUT) writeFileSync(process.env.HARNESS_E2E_OUT, png);
    }
  }
} finally {
  await browser.close();
  server.close();
  if (preview.pid) process.kill(-preview.pid);
}
process.exit(failed === 0 ? 0 : 1);
