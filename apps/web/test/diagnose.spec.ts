// 「診断をコピー」の文面（product#9 の 3。暫定）。作者が AI に貼って「直して」と言うための短いテキスト。
import type { GameMeta, SessionResult } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/draft/diagnose.ts";

const META: GameMeta = {
  title: "まるタップ",
  verb: "タップ！",
  input: "tap",
  duration: 300,
  target: 12,
};
const ID = "01M782MV00TMYMTHTGG5C6KS3T";
const result = (over: Partial<SessionResult>): SessionResult => ({
  score: 0,
  frames: 300,
  via: "guest",
  scoreable: true,
  flagged: false,
  ...over,
});
const base = { postId: ID, meta: META, speed: 1 as const, inputs: 0, problem: null };

describe("diagnose", () => {
  it("普通に終わって target に届いた場合は、気づきなし", () => {
    const text = diagnose({ ...base, result: result({ score: 14 }), inputs: 20 });
    expect(text).toBe(
      [
        "GameFeed 試遊の診断",
        `post_id: ${ID}`,
        "ゲーム: まるタップ（動詞: タップ！ / 入力: tap / 長さ: 300 フレーム / target: 12）",
        "速度: 1 倍",
        "終わり方: 正常（end が届いた）",
        "点: 14（target 12 以上）",
        "フレーム: 300 / 300",
        "入力: 20 回",
        "気づき: なし",
      ].join("\n"),
    );
  });

  it("点が 0・入力が 0 のときは、それぞれ気づきに出す", () => {
    const text = diagnose({ ...base, result: result({ score: 0 }) });
    expect(text).toContain("点: 0（target 12 未満）");
    expect(text).toContain(
      "- 点が 0 のままでした。GF.score への加算が呼ばれているか確かめてください。",
    );
    expect(text).toContain(
      "- 入力が 1 回も記録されていません。入力は GF.onInput で受けてください（addEventListener の入力は記録されません）。",
    );
  });

  it("end が呼ばれず監視タイマーで終わった（固まった）", () => {
    const text = diagnose({ ...base, result: result({ via: "timeout" }), inputs: 3 });
    expect(text).toContain("終わり方: 時間切れ（end が届かなかった）");
    expect(text).toContain(
      "- end が届きませんでした。onTick の中の無限ループや重い処理で固まっている可能性があります。",
    );
  });

  it("例外で止まった", () => {
    const text = diagnose({
      ...base,
      result: result({ via: "error", frames: undefined as never }),
      problem: "TypeError: x is undefined",
    });
    expect(text).toContain("終わり方: 例外で停止");
    expect(text).toContain("例外: TypeError: x is undefined");
    expect(text).not.toContain("フレーム:");
  });

  it("壁時計で短く終わった（遅い）・入力ログの順序違反", () => {
    const text = diagnose({
      ...base,
      result: result({ score: 13, frames: 210, flagged: true }),
      inputs: 5,
      speed: 1.5,
    });
    expect(text).toContain("速度: 1.5 倍");
    expect(text).toContain("フレーム: 210 / 300");
    expect(text).toContain(
      "- 300 フレームに届かず 210 フレームで終わりました。GF.end() を呼んでいないなら、onTick か onDraw が重くて処理が追いついていません。",
    );
    expect(text).toContain("- 入力ログの順序が乱れました（SDK の不具合の可能性）。");
  });

  it("結果が出る前に壊れた（プロトコル違反・ページ移動）", () => {
    const text = diagnose({
      ...base,
      result: null,
      problem: "ゲームが別のページへ移動しようとしたため止めました",
    });
    expect(text).toContain("終わり方: 中断");
    expect(text).toContain("例外: ゲームが別のページへ移動しようとしたため止めました");
  });

  it("メタ宣言が読めていない（ready が届く前）", () => {
    const text = diagnose({ ...base, meta: null, result: null, problem: null });
    expect(text).toContain(
      "ゲーム: （ready が届いていません。SDK が動く前に例外が出ている可能性があります）",
    );
  });
});
