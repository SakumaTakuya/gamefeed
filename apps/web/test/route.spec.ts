import { describe, expect, it } from "vitest";
import { routeOf } from "../src/route.ts";

describe("routeOf", () => {
  it("/draft/<post_id> は試遊ページ（mc#A.9）。末尾スラッシュも受ける", () => {
    const id = "01M782MV00TMYMTHTGG5C6KS3T";
    expect(routeOf(`/draft/${id}`)).toEqual({ page: "draft", postId: id });
    expect(routeOf(`/draft/${id}/`)).toEqual({ page: "draft", postId: id });
  });

  it("/ はエンドレスのスタート画面、/r/<run_id> はその山札で新しいランを作る（run#A.14）", () => {
    const id = "01M782MV00TMYMTHTGG5C6KS3T";
    expect(routeOf("/")).toEqual({ page: "run", fromRun: null });
    expect(routeOf(`/r/${id}`)).toEqual({ page: "run", fromRun: id });
    expect(routeOf(`/r/${id}/`)).toEqual({ page: "run", fromRun: id });
  });

  it("R-run.A14-1 /g/<post_id> はゲームページ（run#A.14、mc#A.9）。末尾スラッシュも受ける", () => {
    const id = "01M782MV00TMYMTHTGG5C6KS3T";
    expect(routeOf(`/g/${id}`)).toEqual({ page: "game", postId: id });
    expect(routeOf(`/g/${id}/`)).toEqual({ page: "game", postId: id });
  });

  it("形式外の ID や他のパスはホーム", () => {
    for (const p of [
      "/r",
      "/r/",
      "/r/abc",
      "/r/01M782MV00TMYMTHTGG5C6KS3T/x",
      "/x",
      "/draft",
      "/draft/",
      "/draft/abc",
      "/draft/01m782mv00tmymthtgg5c6ks3t",
      "/draft/01M782MV00TMYMTHTGG5C6KS3T/x",
      "/p/x",
      "/g",
      "/g/",
      "/g/abc",
      "/g/01m782mv00tmymthtgg5c6ks3t",
      "/g/01M782MV00TMYMTHTGG5C6KS3T/x",
    ]) {
      expect(routeOf(p), p).toEqual({ page: "home" });
    }
  });
});
