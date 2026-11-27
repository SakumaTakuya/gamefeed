// ドリルの絵の部品（hd#A.3、A.5、A.6、A.8）。値を受け取って描くだけであることを、描いた結果で確かめる。
// 見た目（色、大きさ、動き）は `/dev/host` の見本をブラウザで見る。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunReport } from "../src/run/api.ts";
import type { FlashView } from "../src/run/controller.ts";
import { Binding, Cover, EndStamp, Grading, QuestionPage, ReportPage } from "../src/run/Drill.tsx";
import { reportView } from "../src/run/display.ts";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const count = (html: string, needle: string) => html.split(needle).length - 1;

const flash = (over: Partial<FlashView>): FlashView => ({
  via: "guest",
  score: 12,
  miss: false,
  isNew: false,
  deviation: null,
  ratio: null,
  ...over,
});

describe("R-hd.A3-1 綴じ目（hd#A.3）", () => {
  it("ランの中では、手番・周回（2 周目から）・残機を出す", () => {
    const first = renderToStaticMarkup(<Binding turn={1} lap={0} lives={3} />);
    expect(text(first)).toBe("第 1 問");
    expect(count(first, 'class="dr-life"')).toBe(3);
    expect(count(first, 'data-on=""')).toBe(3);

    const later = renderToStaticMarkup(<Binding turn={19} lap={1} lives={1} />);
    expect(text(later)).toBe("第 19 問 2 周目");
    expect(count(later, 'class="dr-life"')).toBe(3);
    expect(count(later, 'data-on=""')).toBe(1);
    expect(later).toContain('aria-label="のこり 1"');
  });

  it("残機の無いラン（デイリー）は丸を出さない。ランの外は題字とランの種類", () => {
    const daily = renderToStaticMarkup(<Binding turn={4} lap={0} lives={null} />);
    expect(text(daily)).toBe("第 4 問");
    expect(daily).not.toContain("dr-life");

    const outside = renderToStaticMarkup(<Binding turn={null} lap={0} lives={null} />);
    expect(text(outside)).toBe("GameFeed エンドレス");
    expect(outside).not.toContain("dr-life");
  });

  it("Host の層は必ず紙を持つ: 方眼の紙か、紙の色の幕（hd#A.9）", () => {
    const pages = [
      renderToStaticMarkup(<QuestionPage turn={1} meta={null} lap={0} />),
      renderToStaticMarkup(<Grading flash={flash({})} />),
      renderToStaticMarkup(<Grading flash={null} />),
      renderToStaticMarkup(<EndStamp word="おわり" />),
    ];
    for (const html of pages) expect(html).toMatch(/^<div class="dr-page (dr-squared|dr-veil)/);
  });
});

describe("R-hd.A5-1 問題のページ（hd#A.5、H4）", () => {
  it("出す文字は、手番の番号・動詞・入力・周回だけ", () => {
    const html = renderToStaticMarkup(
      <QuestionPage turn={7} meta={{ verb: "うけとめろ！", input: "drag" }} lap={0} />,
    );
    // 「点」は得点欄の飾り、「— 7 —」はページ番号の飾り
    expect(text(html)).toBe("点 第 7 問 うけとめろ！ ドラッグ — 7 —");

    const second = renderToStaticMarkup(
      <QuestionPage turn={14} meta={{ verb: "タップ！", input: "tap" }} lap={1} />,
    );
    expect(text(second)).toBe("点 第 14 問 タップ！ タップ 2 周目 — 14 —");
  });

  it("新作かどうかを受け取らない。メタが同じなら、描いた結果は同じ（run#B.6）", () => {
    // 部品の入力に is_new が無いことが保証。ここでは、余分な値を渡しても結果が変わらないことを見る
    const meta = { verb: "とべ！", input: "tap" as const };
    const a = renderToStaticMarkup(<QuestionPage turn={3} meta={meta} lap={0} />);
    const b = renderToStaticMarkup(
      <QuestionPage turn={3} meta={{ ...meta, ...{ is_new: true, isNew: true } }} lap={0} />,
    );
    expect(b).toBe(a);
    expect(a).not.toMatch(/新作|校正/);
  });

  it("メタがまだ届いていなければ「…」。「続きから」は動詞だけ", () => {
    expect(text(renderToStaticMarkup(<QuestionPage turn={2} meta={null} lap={0} />))).toBe(
      "点 第 2 問 … — 2 —",
    );
    const resuming = renderToStaticMarkup(
      <QuestionPage turn={2} meta={{ verb: "タップ！", input: "tap" }} lap={0} resuming />,
    );
    expect(text(resuming)).toBe("点 第 2 問 続きから タップ！ — 2 —");
  });

  it("表紙は「はじめる」。始められない間は押せず、待っている理由を出す", () => {
    const ready = renderToStaticMarkup(<Cover onStart={() => {}} waiting={null} />);
    expect(text(ready)).toBe("GameFeed エンドレス ドリル ぜんぶで 50 問 はじめる");
    expect(ready).not.toContain("disabled");
    const waiting = renderToStaticMarkup(<Cover onStart={null} waiting="読み込んでいます…" />);
    expect(text(waiting)).toBe("GameFeed エンドレス ドリル ぜんぶで 50 問 読み込んでいます…");
    expect(waiting).toContain("disabled");
  });
});

describe("R-hd.A6-1 採点（hd#A.6）", () => {
  const mark = (html: string) => /data-mark="([a-z]+)"/.exec(html)?.[1] ?? null;

  it("ミスは ✕ と「ミス」。応答の偏差値が何であっても", () => {
    for (const deviation of [null, 31.2, 45]) {
      const html = renderToStaticMarkup(<Grading flash={flash({ miss: true, deviation })} />);
      expect(mark(html)).toBe("batsu");
      expect(text(html)).toContain("ミス");
    }
  });

  it("ミスでなければ、応答の偏差値が届くまで印なし。届いたら 花丸・○・△", () => {
    const waiting = renderToStaticMarkup(<Grading flash={flash({})} />);
    expect(mark(waiting)).toBeNull();
    expect(text(waiting)).toBe("12 点");
    expect(mark(renderToStaticMarkup(<Grading flash={flash({ deviation: 60 })} />))).toBe(
      "hanamaru",
    );
    expect(mark(renderToStaticMarkup(<Grading flash={flash({ deviation: 59.9 })} />))).toBe("maru");
    const low = renderToStaticMarkup(<Grading flash={flash({ deviation: 39.5 })} />);
    expect(mark(low)).toBe("sankaku");
    expect(text(low)).toBe("12 点 偏差値 39.5");
  });

  it("校正中と skip は印なし。skip は点数の代わりに「—」", () => {
    const calibrating = renderToStaticMarkup(
      <Grading flash={flash({ isNew: true, ratio: 0.5 })} />,
    );
    expect(mark(calibrating)).toBeNull();
    expect(text(calibrating)).toBe("12 点 校正中 50%");
    const timeout = renderToStaticMarkup(
      <Grading flash={flash({ via: "timeout", score: null })} />,
    );
    expect(mark(timeout)).toBeNull();
    expect(text(timeout)).toBe("— 時間切れ（成績に入りません）");
  });

  it("印は一筆（✕ だけ 2 画）。線の長さを 1 に揃えて、描く動きを CSS に任せる", () => {
    const strokes = (deviation: number | null, miss = false) =>
      count(renderToStaticMarkup(<Grading flash={flash({ deviation, miss })} />), "<path ");
    expect(strokes(70)).toBe(1);
    expect(strokes(55)).toBe(1);
    expect(strokes(45)).toBe(1);
    expect(strokes(null, true)).toBe(2);
    expect(renderToStaticMarkup(<Grading flash={flash({ deviation: 70 })} />)).toContain(
      'pathLength="1"',
    );
  });
});

describe("R-hd.A8-1 成績表（hd#A.8、H5）", () => {
  const A = "01M782MV00TMYMTHTGG5C6KS3A";
  const B = "01M782MV00TMYMTHTGG5C6KS3B";
  const report: RunReport = {
    run_id: "01M782MV00TMYMTHTGG5C6KS3R",
    mode: "endless",
    ended: "lives",
    reached: 5,
    avg_deviation: 56.2,
    symbols: null,
    turns: [
      { turn: 0, post_id: A, kind: "ok", deviation: 64.1, ratio: null, is_new: false, speed: 1 },
      { turn: 1, post_id: B, kind: "ok", deviation: null, ratio: 0.5, is_new: true, speed: 1 },
      {
        turn: 2,
        post_id: A,
        kind: "ok",
        deviation: 44.4,
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
        is_new: false,
        speed: 1.125,
      },
      {
        turn: 4,
        post_id: A,
        kind: "miss",
        deviation: 38.0,
        ratio: null,
        is_new: false,
        speed: 1.125,
      },
    ],
  };
  const view = reportView(report, { unsettled: 0, titles: { [A]: { title: "まるタップ" } } });

  it("出す値は `finish` の凍結値を `reportView` が文字にしたものだけ。項目は run#A.11 のまま", () => {
    const html = renderToStaticMarkup(<ReportPage report={view} />);
    expect(text(html)).toBe(
      [
        "エンドレス・終了 5 本 総合偏差値 56.2（参考） よくできました",
        "1 まるタップ 64.1",
        "2 — 校正中 50% —",
        "3 まるタップ ×1.125 44.4",
        "4 — ×1.125 — —",
        "5 まるタップ ×1.125 38.0",
      ].join(" "),
    );
  });

  it("科目欄の印は採点と同じ 4 つ。校正中と skip は「—」", () => {
    const html = renderToStaticMarkup(<ReportPage report={view} />);
    expect([...html.matchAll(/data-mark="([a-z]+)"/g)].map((m) => m[1])).toEqual([
      "hanamaru",
      "sankaku",
      "batsu",
    ]);
    expect(view.rows.map((r) => r.mark)).toEqual(["hanamaru", null, "sankaku", null, "batsu"]);
  });

  it("記録に入らなかった手番の知らせと、渡したボタンを出す", () => {
    const html = renderToStaticMarkup(
      <ReportPage report={{ ...view, notice: "通信できなかった 2 本は記録されていません" }}>
        <button type="button">もう一回</button>
      </ReportPage>,
    );
    expect(text(html)).toContain("通信できなかった 2 本は記録されていません");
    expect(text(html).endsWith("もう一回")).toBe(true);
  });
});
