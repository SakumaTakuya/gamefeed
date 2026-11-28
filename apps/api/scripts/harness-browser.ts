// headless Chromium でハーネスのページを開き、結果とサムネを取る（scoring.md A.10）。
// 公開直後のジョブ（scripts/post-publish.ts）から使う。API の束には入れない。
import type { Browser } from "playwright";
import { type HarnessReport, type HarnessRun, THUMB_AFTER_SEC } from "../src/post-publish.ts";

/** ページを開くまでの上限 */
const OPEN_TIMEOUT_MS = 20_000;
/** 1 回の上限。ゲームは最長 10 秒（gc#A.3）で、監視タイマーはその少し後に切れる */
const RUN_TIMEOUT_MS = 30_000;
/** サムネの大きさ（暫定）。縦長の舞台と同じ比 */
export const THUMB_SIZE = { width: 360, height: 640 } as const;

export interface HarnessShot extends HarnessRun {
  /** `start` から 1.5 秒後のゲームの画面（PNG）。撮らなかった・撮れなかったら null */
  png: Uint8Array | null;
}

/** ハーネスのページを 1 回走らせる。例外は投げず、読めなかったことは `report: null` で返す */
export async function runHarness(
  browser: Browser,
  o: { appOrigin: string; postId: string; speed: number; shoot: boolean },
): Promise<HarnessShot> {
  const context = await browser.newContext({ viewport: THUMB_SIZE, deviceScaleFactor: 1 });
  const out: HarnessShot = { speed: o.speed, gameStatus: null, report: null, png: null };
  try {
    const page = await context.newPage();
    // ゲームの HTML（配信オリジンの /p/<post_id>/）の応答。配信されたかどうかの判断に使う
    page.on("response", (res) => {
      try {
        if (new URL(res.url()).pathname === `/p/${o.postId}/`) out.gameStatus ??= res.status();
      } catch {
        // URL でない応答は見ない
      }
    });
    const url = `${o.appOrigin}/harness/${o.postId}?speed=${o.speed}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: OPEN_TIMEOUT_MS });
    } catch {
      return out;
    }
    const holder = page.locator("[data-harness]");
    const frame = page.locator("iframe");
    const shoot = async () => {
      if (!o.shoot || out.png) return;
      out.png = await frame.screenshot({ type: "png", timeout: 5000 }).catch(() => null);
    };
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let runningSince: number | null = null;
    while (Date.now() < deadline) {
      const raw = await holder.getAttribute("data-harness", { timeout: 3000 }).catch(() => null);
      if (raw) out.report = JSON.parse(raw) as HarnessReport;
      if (out.report?.phase === "running") {
        runningSince ??= Date.now();
        if (Date.now() - runningSince >= (THUMB_AFTER_SEC * 1000) / o.speed) await shoot();
      }
      if (out.report?.phase === "done") {
        // 1.5 秒より前に終わったゲームは、終わった画面を撮る
        if (out.report.outcome === "ended") await shoot();
        break;
      }
      await page.waitForTimeout(40);
    }
    return out;
  } finally {
    await context.close();
  }
}

/** PNG を WebP にする。ブラウザの canvas を使う（画像の依存を足さない） */
export async function toWebp(browser: Browser, png: Uint8Array): Promise<Uint8Array | null> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // apps/api の型は DOM を持たないので、ページの中のコードは文字列で渡す
    const src = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const b64 = (await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(src)};
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = ${THUMB_SIZE.width};
      canvas.height = ${THUMB_SIZE.height};
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/webp", 0.8);
      return dataUrl.startsWith("data:image/webp;base64,") ? dataUrl.slice(23) : null;
    })()`)) as string | null;
    return b64 ? new Uint8Array(Buffer.from(b64, "base64")) : null;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}
