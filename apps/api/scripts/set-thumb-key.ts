import { appendFileSync } from "node:fs";
import { createDb } from "../src/db/client.ts";
import { MANUAL_THUMB_KEY, setManualThumb } from "../src/manual-thumb.ts";

// 公開した投稿に thumb_key の目印を入れて、新作枠に入れる（#185）。Actions の `set-thumb-key` から実行する。
// 手元なら: DATABASE_URL=… POST_ID=<post_id> pnpm --filter @gamefeed/api thumb:set
const url = process.env.DATABASE_URL;
const postId = (process.env.POST_ID ?? process.argv[2] ?? "").trim();
if (!url) {
  console.error("DATABASE_URL を設定してください");
  process.exit(1);
}

/** Actions の実行結果のページにも出す */
function report(line: string): void {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${line}\n\n`);
}

const { db, close } = createDb(url, { max: 1 });
try {
  const r = await setManualThumb(db, postId);
  if (!r.ok) {
    let why: string;
    if (r.error === "not_published") {
      why = `公開していない投稿です（状態: ${r.status}）。先に publish_game で公開してください`;
    } else if (r.error === "not_found") {
      why = "その post_id の投稿がありません";
    } else {
      why = "post_id の形が違います（ULID、26 文字、大文字）";
    }
    report(`NG \`${postId}\`: ${why}`);
    process.exitCode = 1;
  } else {
    report(
      r.changed
        ? `OK \`${postId}\`: thumb_key に \`${MANUAL_THUMB_KEY}\` を入れました`
        : `OK \`${postId}\`: thumb_key はもう入っています（変えていません）`,
    );
    report(`状態: ${r.status} / 校正: ${r.calibration} / ランへの出題: ${r.eligibility}`);
    if (r.eligibility === "none") {
      // 入れてもランに出ない（校正状態が review / invalid）。失敗にはしないが、目に付くようにする
      console.log(`::warning::${postId} はランに出ません（校正: ${r.calibration}）`);
    }
  }
} finally {
  await close();
}
