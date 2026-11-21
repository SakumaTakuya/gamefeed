// 通報のカテゴリ・係数・重み・本文の検査（moderation.md A.4、A.9）。
import { describe, expect, it } from "vitest";
import {
  AUTO_RESTRICT_SEVERE,
  AUTO_RESTRICT_SUM,
  autoRestrict,
  parseReportInput,
  REPORT_CATEGORIES,
  REPORT_COEF,
  REPORT_COMMENT_MAX,
  reportWeight,
} from "../src/index.ts";

describe("通報の定数（mo#A.4、A.9）", () => {
  it("R-mo.A4-1 カテゴリは 9 種", () => {
    expect([...REPORT_CATEGORIES].sort()).toEqual(
      [
        "broken",
        "copyright",
        "flashing",
        "hate",
        "loud",
        "other",
        "sexual",
        "spam",
        "violence",
      ].sort(),
    );
  });

  it("R-mo.A4-2 係数は sexual / flashing が 3、broken が 0.2、ほかは 1", () => {
    expect(REPORT_COEF).toEqual({
      sexual: 3,
      flashing: 3,
      violence: 1,
      hate: 1,
      copyright: 1,
      loud: 1,
      spam: 1,
      broken: 0.2,
      other: 1,
    });
    expect(REPORT_COMMENT_MAX).toBe(200);
  });
});

describe("reportWeight（信頼係数 × カテゴリ係数）", () => {
  it("R-mo.A4-2 匿名（trust_score が無い）は、どのカテゴリでも 0（I14）", () => {
    for (const c of REPORT_CATEGORIES) expect(reportWeight(null, c)).toBe(0);
  });

  it("R-mo.A4-2 ログイン済みは trust_score ÷ 10 × 係数（新規 10 → 1.0、最大 100 → 10.0）", () => {
    expect(reportWeight(10, "sexual")).toBeCloseTo(3);
    expect(reportWeight(10, "spam")).toBeCloseTo(1);
    expect(reportWeight(10, "broken")).toBeCloseTo(0.2);
    expect(reportWeight(50, "sexual")).toBeCloseTo(15);
    expect(reportWeight(50, "broken")).toBeCloseTo(1);
    expect(reportWeight(17, "sexual")).toBeCloseTo(5.1);
    expect(reportWeight(100, "other")).toBeCloseTo(10);
    expect(reportWeight(0, "sexual")).toBe(0);
  });
});

describe("parseReportInput（{category, comment?}）", () => {
  it("R-mo.A4-1 カテゴリだけで通る。comment が無い・null は null", () => {
    expect(parseReportInput({ category: "spam" })).toEqual({ category: "spam", comment: null });
    expect(parseReportInput({ category: "spam", comment: null })).toEqual({
      category: "spam",
      comment: null,
    });
    for (const c of REPORT_CATEGORIES) expect(parseReportInput({ category: c })?.category).toBe(c);
  });

  it("R-mo.A4-1 コメントは前後の空白を落とす。空白だけなら null", () => {
    expect(parseReportInput({ category: "other", comment: "  音が大きい\n" })?.comment).toBe(
      "音が大きい",
    );
    expect(parseReportInput({ category: "other", comment: " \n\t " })?.comment).toBeNull();
  });

  it("R-mo.A4-1 コメントは 200 文字まで（符号位置で数える。絵文字も 1 文字）", () => {
    expect(
      parseReportInput({ category: "other", comment: "あ".repeat(200) })?.comment,
    ).toHaveLength(200);
    expect(parseReportInput({ category: "other", comment: "あ".repeat(201) })).toBeNull();
    expect(parseReportInput({ category: "other", comment: "😀".repeat(200) })).not.toBeNull();
    expect(parseReportInput({ category: "other", comment: "😀".repeat(201) })).toBeNull();
    // 前後の空白は数えない
    expect(
      parseReportInput({ category: "other", comment: ` ${"あ".repeat(200)} ` }),
    ).not.toBeNull();
  });

  it("形の違う本文は null: 本文なし、知らないカテゴリ、文字列でないコメント", () => {
    for (const body of [
      null,
      undefined,
      "spam",
      [],
      {},
      { category: "nope" },
      { category: "Spam" },
      { category: 1 },
      { category: "toString" },
      { category: "spam", comment: 1 },
      { category: "spam", comment: ["x"] },
      // U+0000 は Postgres の text に入らない
      { category: "spam", comment: "a\u0000b" },
      { category: "spam", comment: "\u0000" },
    ]) {
      expect(parseReportInput(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("autoRestrict（open の通報の重みの合計で決める。mo#A.4）", () => {
  it("R-mo.A4-3 閾値は全カテゴリの合計 10、sexual / flashing だけで 5", () => {
    expect(AUTO_RESTRICT_SUM).toBe(10);
    expect(AUTO_RESTRICT_SEVERE).toBe(5);
  });

  it("R-mo.A4-3 新規 10 人の spam で制限、9 人では制限しない", () => {
    expect(autoRestrict([{ category: "spam", weight: 9, count: 9 }])).toMatchObject({
      restrict: false,
      total: 9,
      severe: 0,
    });
    expect(autoRestrict([{ category: "spam", weight: 10, count: 10 }])).toMatchObject({
      restrict: true,
      total: 10,
      severe: 0,
    });
  });

  it("R-mo.A4-3 sexual / flashing は合わせて 5 以上で制限（新規 2 人の sexual、sexual + flashing、信頼 17 の 1 件）", () => {
    expect(autoRestrict([{ category: "sexual", weight: 3, count: 1 }]).restrict).toBe(false);
    expect(autoRestrict([{ category: "sexual", weight: 6, count: 2 }])).toMatchObject({
      restrict: true,
      total: 6,
      severe: 6,
    });
    expect(
      autoRestrict([
        { category: "sexual", weight: 3, count: 1 },
        { category: "flashing", weight: 3, count: 1 },
      ]).restrict,
    ).toBe(true);
    expect(
      autoRestrict([{ category: "sexual", weight: reportWeight(17, "sexual"), count: 1 }]).restrict,
    ).toBe(true);
    expect(
      autoRestrict([{ category: "sexual", weight: reportWeight(16, "sexual"), count: 1 }]).restrict,
    ).toBe(false);
  });

  it("R-mo.A4-3 ほかのカテゴリは severe に数えない。合計には全部を数える", () => {
    const d = autoRestrict([
      { category: "sexual", weight: 3, count: 1 },
      { category: "spam", weight: 4, count: 4 },
      { category: "broken", weight: 2.8, count: 14 },
    ]);
    expect(d.restrict).toBe(false);
    expect(d.total).toBeCloseTo(9.8);
    expect(d.severe).toBe(3);
    expect(
      autoRestrict([
        { category: "sexual", weight: 3, count: 1 },
        { category: "spam", weight: 4, count: 4 },
        { category: "broken", weight: 3, count: 15 },
      ]).restrict,
    ).toBe(true);
  });

  it("M10 匿名（重み 0）は何件あっても制限しない。通報が無くても制限しない", () => {
    expect(autoRestrict([{ category: "sexual", weight: 0, count: 100000 }]).restrict).toBe(false);
    expect(autoRestrict([])).toMatchObject({ restrict: false, total: 0, severe: 0 });
  });

  it("小数の足し算の誤差で閾値を外さない（0.2 を 50 回足した broken は 10 として扱う）", () => {
    let sum = 0;
    for (let i = 0; i < 50; i++) sum += reportWeight(10, "broken");
    expect(autoRestrict([{ category: "broken", weight: sum, count: 50 }]).restrict).toBe(true);
    let almost = 0;
    for (let i = 0; i < 49; i++) almost += reportWeight(10, "broken");
    expect(autoRestrict([{ category: "broken", weight: almost, count: 49 }]).restrict).toBe(false);
  });

  it("R-mo.A4-3 reason は合計・閾値・カテゴリごとの重みと件数を書く（運営の内部メモ）", () => {
    expect(
      autoRestrict([
        { category: "spam", weight: 4, count: 4 },
        { category: "sexual", weight: 6.1, count: 3 },
      ]).reason,
    ).toBe(
      "自動制限: 合計 10.1（閾値 10）、sexual+flashing 6.1（閾値 5）。内訳: sexual 6.1（3 件）、spam 4（4 件）",
    );
  });
});
