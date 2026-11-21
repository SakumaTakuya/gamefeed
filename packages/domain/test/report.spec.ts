// 通報のカテゴリ・係数・重み・本文の検査（moderation.md A.4、A.9）。
import { describe, expect, it } from "vitest";
import {
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
