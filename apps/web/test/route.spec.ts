import { describe, expect, it } from "vitest";
import { routeOf } from "../src/route.ts";

describe("routeOf", () => {
  it("/draft/<post_id> は試遊ページ（mc#A.9）。末尾スラッシュも受ける", () => {
    const id = "01M782MV00TMYMTHTGG5C6KS3T";
    expect(routeOf(`/draft/${id}`)).toEqual({ page: "draft", postId: id });
    expect(routeOf(`/draft/${id}/`)).toEqual({ page: "draft", postId: id });
  });

  it("形式外の ID や他のパスはホーム", () => {
    for (const p of [
      "/",
      "/draft",
      "/draft/",
      "/draft/abc",
      "/draft/01m782mv00tmymthtgg5c6ks3t",
      "/draft/01M782MV00TMYMTHTGG5C6KS3T/x",
      "/p/x",
    ]) {
      expect(routeOf(p), p).toEqual({ page: "home" });
    }
  });
});
