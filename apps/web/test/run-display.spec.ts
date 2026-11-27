// ラン画面の表示の組み立て（run#A.5、A.7、A.10、A.11）。Host は成績を計算せず、受け取った値を文字にするだけ。
import { describe, expect, it } from "vitest";
import type { RunReport } from "../src/run/api.ts";
import type { FlashView } from "../src/run/controller.ts";
import {
  flashMark,
  flashText,
  inputLabel,
  lapLabel,
  livesText,
  reportView,
  stampText,
  turnLabel,
} from "../src/run/display.ts";

const A = "01M782MV00TMYMTHTGG5C6KS3A";
const B = "01M782MV00TMYMTHTGG5C6KS3B";

const flash = (over: Partial<FlashView>): FlashView => ({
  via: "guest",
  score: 12,
  miss: false,
  isNew: false,
  deviation: null,
  ratio: null,
  ...over,
});

describe("flashText（結果フラッシュ。run#A.5 の 2、A.10）", () => {
  it("点を出す。応答の偏差値が届いたら足す", () => {
    expect(flashText(flash({}))).toEqual({ main: "12 点", sub: null, miss: false });
    expect(flashText(flash({ deviation: 52.34 }))).toEqual({
      main: "12 点",
      sub: "偏差値 52.3",
      miss: false,
    });
  });

  it("ミスには印を出す", () => {
    expect(flashText(flash({ miss: true, deviation: 38 }))).toEqual({
      main: "12 点",
      sub: "偏差値 38.0",
      miss: true,
    });
  });

  it("新作扱いの手番は偏差値の代わりに目標との比を出し、「校正中」と添える", () => {
    expect(flashText(flash({ isNew: true }))).toEqual({
      main: "12 点",
      sub: "校正中",
      miss: false,
    });
    expect(flashText(flash({ isNew: true, ratio: 0.8 }))).toEqual({
      main: "12 点",
      sub: "校正中 80%",
      miss: false,
    });
    // 新作扱いでなくても、偏差値が出ない（校正の途中の）ゲームは比
    expect(flashText(flash({ ratio: 1 }))).toEqual({
      main: "12 点",
      sub: "校正中 100%",
      miss: false,
    });
  });

  it("満了と error は点を出さず、成績に入らないことを伝える", () => {
    expect(flashText(flash({ via: "timeout", score: null }))).toEqual({
      main: "—",
      sub: "時間切れ（成績に入りません）",
      miss: false,
    });
    expect(flashText(flash({ via: "error", score: null }))).toEqual({
      main: "—",
      sub: "エラー（成績に入りません）",
      miss: false,
    });
  });
});

describe("livesText（残機。run#A.7）", () => {
  it("残りを ♥、失ったぶんを ♡ で出す。デイリー（null）は出さない", () => {
    expect(livesText(3)).toBe("♥♥♥");
    expect(livesText(1)).toBe("♥♡♡");
    expect(livesText(0)).toBe("♡♡♡");
    expect(livesText(null)).toBe("");
  });
});

describe("reportView（成績表。run#A.11）", () => {
  const report: RunReport = {
    run_id: "01M782MV00TMYMTHTGG5C6KS3R",
    mode: "endless",
    ended: "lives",
    reached: 4,
    avg_deviation: 47.25,
    symbols: null,
    turns: [
      { turn: 0, post_id: A, kind: "ok", deviation: 55.5, ratio: null, is_new: false, speed: 1 },
      { turn: 1, post_id: B, kind: "ok", deviation: null, ratio: 0.5, is_new: true, speed: 1 },
      {
        turn: 2,
        post_id: A,
        kind: "miss",
        deviation: 39,
        ratio: null,
        is_new: false,
        speed: 1.125,
      },
      {
        turn: 3,
        post_id: B,
        kind: "skip",
        deviation: null,
        ratio: null,
        is_new: true,
        speed: 1.125,
      },
    ],
  };
  const titles = { [A]: { title: "まるタップ", verb: "タップ！" } };

  it("見出しは到達手番数、総合は総合偏差値（参考）。科目欄は手番ごとの偏差値・校正中の比・skip の「—」・ミスの印", () => {
    expect(reportView(report, { unsettled: 0, titles })).toEqual({
      heading: "4 本",
      status: "終了",
      overall: "総合偏差値 47.3（参考）",
      stamp: "がんばりました",
      notice: null,
      rows: [
        {
          no: 1,
          title: "まるタップ",
          value: "55.5",
          note: null,
          miss: false,
          mark: "maru",
          speed: null,
        },
        {
          no: 2,
          title: null,
          value: "50%",
          note: "校正中",
          miss: false,
          mark: null,
          speed: null,
        },
        {
          no: 3,
          title: "まるタップ",
          value: "39.0",
          note: null,
          miss: true,
          mark: "batsu",
          speed: "×1.125",
        },
        {
          no: 4,
          title: null,
          value: "—",
          note: null,
          miss: false,
          mark: null,
          speed: "×1.125",
        },
      ],
    });
  });

  it("終わり方: 上限は「完走」、中断・期限は「中断」", () => {
    const opts = { unsettled: 0, titles: {} };
    expect(reportView({ ...report, ended: "limit" }, opts).status).toBe("完走");
    expect(reportView({ ...report, ended: "abandoned" }, opts).status).toBe("中断");
    expect(reportView({ ...report, ended: "error" }, opts).status).toBe("通信エラー");
  });

  it("偏差値のある手番が無ければ総合は「—」", () => {
    expect(
      reportView({ ...report, avg_deviation: null }, { unsettled: 0, titles: {} }).overall,
    ).toBe("総合偏差値 —");
  });

  it("記録に入らなかった手番があれば、その本数を伝える（run#A.7）", () => {
    expect(reportView(report, { unsettled: 2, titles: {} }).notice).toBe(
      "通信できなかった 2 本は記録されていません",
    );
  });
});

describe("inputLabel（幕間の入力の種類。run#A.5 の 4）", () => {
  it("入力の種類ごとの文字", () => {
    expect(inputLabel("tap")).toBe("タップ");
    expect(inputLabel("hold")).toBe("長押し");
    expect(inputLabel("swipe")).toBe("スワイプ");
    expect(inputLabel("drag")).toBe("ドラッグ");
    expect(inputLabel("stick")).toBe("スティック");
  });
});

describe("ドリルの絵の文字と印（hd#A.3、A.6、A.8）", () => {
  it("手番は「第 n 問」、周回は 2 周目から", () => {
    expect(turnLabel(1)).toBe("第 1 問");
    expect(turnLabel(23)).toBe("第 23 問");
    expect(lapLabel(0)).toBeNull();
    expect(lapLabel(1)).toBe("2 周目");
    expect(lapLabel(3)).toBe("4 周目");
  });

  it("採点の印は遊んだ結果にだけ付く。満了とエラー（skip）は印なし", () => {
    expect(flashMark(flash({ miss: true }))).toBe("batsu");
    expect(flashMark(flash({}))).toBeNull();
    expect(flashMark(flash({ deviation: 61 }))).toBe("hanamaru");
    expect(flashMark(flash({ deviation: 55 }))).toBe("maru");
    expect(flashMark(flash({ deviation: 42 }))).toBe("sankaku");
    expect(flashMark(flash({ isNew: true, ratio: 0.5 }))).toBeNull();
    expect(flashMark(flash({ via: "timeout", score: null }))).toBeNull();
    expect(flashMark(flash({ via: "error", score: null }))).toBeNull();
  });

  it("成績表の判子は総合偏差値から（55 / 45。暫定）。総合が無ければ押さない", () => {
    expect(stampText(null)).toBeNull();
    expect(stampText(55)).toBe("よくできました");
    expect(stampText(54.9)).toBe("がんばりました");
    expect(stampText(45)).toBe("がんばりました");
    expect(stampText(44.9)).toBe("もうすこし");
  });
});
