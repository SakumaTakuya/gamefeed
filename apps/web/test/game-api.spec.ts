// ゲームページが読む `GET /api/posts/{id}` の応答の読み方（mo#A.3）。
import { describe, expect, it } from "vitest";
import { readDeviation, readLiked, readPostLookup } from "../src/game/api.ts";

const body = {
  post_id: "01M782MV00TMYMTHTGG5C6KS3T",
  title: "まるタップ",
  author: { handle: "taku-sakuma" },
  published_at: "2026-11-21T03:00:00.000Z",
  liked: false,
};

describe("readPostLookup", () => {
  it("R-run.A14-3 200 は題名と作者の handle を読む", () => {
    expect(readPostLookup(200, body)).toEqual({
      kind: "found",
      post: {
        postId: body.post_id,
        title: "まるタップ",
        handle: "taku-sakuma",
        liked: false,
        stats: null,
      },
    });
  });

  it("R-run.A14-4 liked を読む。無い・真偽値でないときは「まだ」として扱う（古い応答で画面を壊さない）", () => {
    const liked = (b: unknown) => {
      const r = readPostLookup(200, b);
      return r.kind === "found" ? r.post.liked : null;
    };
    expect(liked({ ...body, liked: true })).toBe(true);
    expect(liked({ ...body, liked: undefined })).toBe(false);
    expect(liked({ ...body, liked: "yes" })).toBe(false);
  });

  it("R-run.A14-6 stats を読む。null・無い・形の違うときは「出さない」として扱う（投稿は読めたまま）", () => {
    const stats = (b: unknown) => {
      const r = readPostLookup(200, b);
      return r.kind === "found" ? r.post.stats : "not found";
    };
    expect(stats({ ...body, stats: { plays: 120, likes: 7 } })).toEqual({ plays: 120, likes: 7 });
    expect(stats({ ...body, stats: { plays: 0, likes: 0 } })).toEqual({ plays: 0, likes: 0 });
    expect(stats({ ...body, stats: null })).toBeNull();
    expect(stats(body)).toBeNull();
    expect(stats({ ...body, stats: { plays: "120", likes: 7 } })).toBeNull();
    expect(stats({ ...body, stats: { plays: 120 } })).toBeNull();
    expect(stats({ ...body, stats: { plays: -1, likes: 7 } })).toBeNull();
    expect(stats({ ...body, stats: { plays: 1.5, likes: 7 } })).toBeNull();
    expect(stats({ ...body, stats: [120, 7] })).toBeNull();
  });

  it("R-run.A14-2 404 の not_found だけが「無い」", () => {
    expect(readPostLookup(404, { error: "not_found" })).toEqual({ kind: "not_found" });
  });

  it("それ以外は「分からない」（遊ぶのを止めない）: 5xx、形の違う 200、本文の無い 404、応答なし", () => {
    const unknown = { kind: "unknown" };
    expect(readPostLookup(503, { error: "not_configured" })).toEqual(unknown);
    expect(readPostLookup(500, null)).toEqual(unknown);
    // 古いデプロイや途中のプロキシが返す 404（SPA の index.html など）で、遊べるゲームを閉じない
    expect(readPostLookup(404, null)).toEqual(unknown);
    expect(readPostLookup(404, { error: "nope" })).toEqual(unknown);
    expect(readPostLookup(200, null)).toEqual(unknown);
    expect(readPostLookup(200, { ...body, author: null })).toEqual(unknown);
    expect(readPostLookup(200, { ...body, author: { handle: 1 } })).toEqual(unknown);
    expect(readPostLookup(200, { ...body, title: undefined })).toEqual(unknown);
    expect(readPostLookup(200, { ...body, post_id: 1 })).toEqual(unknown);
    expect(readPostLookup(0, undefined)).toEqual(unknown);
  });
});

describe("readLiked（PUT /api/posts/{id}/like の応答）", () => {
  it("R-run.A14-4 200 の {liked: true} だけが成功", () => {
    expect(readLiked(200, { liked: true })).toBe(true);
    expect(readLiked(200, { liked: false })).toBe(false);
    expect(readLiked(200, null)).toBe(false);
    expect(readLiked(404, { error: "not_found" })).toBe(false);
    expect(readLiked(400, { error: "invalid_device" })).toBe(false);
    expect(readLiked(500, { liked: true })).toBe(false);
  });
});

describe("readDeviation（GET /api/posts/{id}/deviation の応答）", () => {
  it("R-run.A14-6 200 の {deviation: 数} だけが値。校正済みでない（null）・失敗・形の違う応答は「出さない」", () => {
    expect(readDeviation(200, { deviation: 62.3 })).toBe(62.3);
    expect(readDeviation(200, { deviation: 20 })).toBe(20);
    expect(readDeviation(200, { deviation: null })).toBeNull();
    expect(readDeviation(200, { deviation: "62.3" })).toBeNull();
    expect(readDeviation(200, { deviation: Number.NaN })).toBeNull();
    expect(readDeviation(200, {})).toBeNull();
    expect(readDeviation(200, null)).toBeNull();
    expect(readDeviation(404, { error: "not_found" })).toBeNull();
    expect(readDeviation(400, { error: "invalid_request" })).toBeNull();
    expect(readDeviation(500, { deviation: 62.3 })).toBeNull();
  });
});
