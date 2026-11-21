// ゲームページの通報（mo#A.4、run#A.14）。カテゴリの表示名と、応答の読み方。
import { REPORT_CATEGORIES } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import { REPORT_OPTIONS, readReportResult, reportDraft } from "../src/game/report.ts";

describe("REPORT_OPTIONS", () => {
  it("R-run.A14-5 カテゴリ 9 種すべてに表示名があり、順は mo#A.4 の表のとおり", () => {
    expect(REPORT_OPTIONS.map((o) => o.category)).toEqual([...REPORT_CATEGORIES]);
    expect(REPORT_OPTIONS.map((o) => o.label)).toEqual([
      "性的",
      "光の点滅がきつい",
      "暴力・グロ",
      "差別・中傷",
      "著作権・他人の作品",
      "音が大きい・不快",
      "スパム・無内容・宣伝",
      "動作しない",
      "その他",
    ]);
  });
});

describe("reportDraft（送る前の検査）", () => {
  it("R-run.A14-5 カテゴリを選ぶまで送れない。コメントは任意で、前後の空白を落とす", () => {
    expect(reportDraft(null, "")).toEqual({ ok: false, left: 200 });
    expect(reportDraft("spam", "")).toEqual({
      ok: true,
      left: 200,
      input: { category: "spam", comment: null },
    });
    expect(reportDraft("other", "  音が大きい ")).toEqual({
      ok: true,
      left: 195,
      input: { category: "other", comment: "音が大きい" },
    });
  });

  it("R-run.A14-5 コメントが 200 文字を超えたら送れない（符号位置で数える。サーバと同じ）", () => {
    expect(reportDraft("other", "あ".repeat(200))).toMatchObject({ ok: true, left: 0 });
    expect(reportDraft("other", "あ".repeat(201))).toEqual({ ok: false, left: -1 });
    expect(reportDraft("other", "😀".repeat(200))).toMatchObject({ ok: true, left: 0 });
  });
});

describe("readReportResult（POST /api/posts/{id}/reports の応答）", () => {
  it("R-run.A14-5 200 の {reported: true} は成功。400 の invalid は作者自身。ほかは失敗（もう一度送れる）", () => {
    expect(readReportResult(200, { reported: true })).toBe("reported");
    expect(readReportResult(400, { error: "invalid" })).toBe("own");
    for (const [status, body] of [
      [200, null],
      [200, { reported: false }],
      [400, { error: "invalid_request" }],
      [400, { error: "invalid_device" }],
      [404, { error: "not_found" }],
      [503, { error: "not_configured" }],
      [500, null],
      [0, undefined],
    ] as const) {
      expect(readReportResult(status, body), `${status}`).toBe("failed");
    }
  });
});
