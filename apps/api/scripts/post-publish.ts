import { appendFileSync } from "node:fs";
import { createDb } from "../src/db/client.ts";
import {
  applyCheck,
  CHECK_SPEEDS,
  type HarnessRun,
  judge,
  type PendingPost,
  pendingPosts,
} from "../src/post-publish.ts";
import { createR2Storage } from "../src/r2.ts";

// 公開直後のジョブ（mcp.md A.9、scoring.md A.10）。Actions の `post-publish`（10 分ごと）から実行する。
// 公開されて実行チェックがまだの投稿を、headless Chromium でハーネスのページ（<APP_ORIGIN>/harness/<post_id>）に
// 通し、終われば thumb_key（とサムネ）を入れ、固まるなら calibration = invalid にする。
//
//   DATABASE_URL=… pnpm --filter @gamefeed/api post-publish count   対象の件数だけ出す（ブラウザを使わない）
//   DATABASE_URL=… APP_ORIGIN=https://… pnpm --filter @gamefeed/api post-publish
//   POST_ID=<post_id> を付けると、その 1 件だけ（状態は applyCheck が見る）
//   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT / R2_BUCKET が揃っていればサムネを保存する。
//   無ければ実行チェックだけして、thumb_key に目印 `manual` を入れる
const env = process.env;
const mode = process.argv[2] ?? "run";
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL を設定してください");
  process.exit(1);
}

/** Actions の実行結果のページにも出す */
function report(line: string): void {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n\n`);
}

const r2 =
  env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT && env.R2_BUCKET
    ? createR2Storage({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        endpoint: env.R2_ENDPOINT,
        bucket: env.R2_BUCKET,
      })
    : null;

const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
try {
  const only = (env.POST_ID ?? "").trim();
  const targets: PendingPost[] = only
    ? [{ id: only, thumbKey: null }]
    : await pendingPosts(db, { redoManual: r2 !== null });

  if (mode === "count") {
    console.log(`対象 ${targets.length} 件`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `count=${targets.length}\n`);
  } else if (targets.length > 0) {
    const appOrigin = (env.APP_ORIGIN ?? "").replace(/\/+$/, "");
    if (!appOrigin) throw new Error("APP_ORIGIN を設定してください（ハーネスのページのオリジン）");
    if (!r2) report("R2 の鍵が無いので、サムネは保存せず目印を入れます");
    // ブラウザは対象があるときだけ読み込む
    const { chromium } = await import("playwright");
    const { runHarness, toWebp } = await import("./harness-browser.ts");
    const browser = await chromium.launch();
    try {
      for (const post of targets) {
        const runs: HarnessRun[] = [];
        let png: Uint8Array | null = null;
        for (const speed of CHECK_SPEEDS) {
          const shot = await runHarness(browser, {
            appOrigin,
            postId: post.id,
            speed,
            shoot: speed === 1 && r2 !== null,
          });
          runs.push({ speed: shot.speed, gameStatus: shot.gameStatus, report: shot.report });
          png ??= shot.png;
          // 終わらなかった回の後は走らせない（結果は決まっている）
          if (shot.report?.phase !== "done" || shot.report.outcome !== "ended") break;
        }
        const outcome = judge(runs);
        const thumb = outcome.kind === "ok" && png ? await toWebp(browser, png) : null;
        const did = await applyCheck(db, post.id, outcome, { thumb, storage: r2 });
        const why = outcome.kind === "ok" ? "" : `（${outcome.reason}）`;
        report(`\`${post.id}\`: ${outcome.kind}${why} → ${did}`);
      }
    } finally {
      await browser.close();
    }
  } else {
    console.log("対象なし");
  }
} finally {
  await close();
}
