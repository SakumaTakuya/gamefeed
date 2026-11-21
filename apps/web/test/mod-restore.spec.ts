// 運営の最小ページ（mo#A.7 の restore）。理由の検査と、応答の読み方・伝え方。
import { describe, expect, it } from "vitest";
import { readRestoreReply, restoreReason, restoreText } from "../src/mod/restore.ts";

const ID = "01M782MV00TMYMTHTGG5C6KS3T";

describe("restoreReason（送る前の検査）", () => {
  it("R-mo.A7-3 理由は必須。前後の空白を落として空なら送れない", () => {
    expect(restoreReason("")).toBeNull();
    expect(restoreReason("  \n ")).toBeNull();
    expect(restoreReason("  誤制限  ")).toBe("誤制限");
  });
});

describe("readRestoreReply（応答の読み方）", () => {
  it("R-mo.A7-3 200 は形を確かめてから restored。形が違えば failed", () => {
    expect(
      readRestoreReply(200, { post_id: ID, status: "public", dismissed: 2, served: true }),
    ).toEqual({ kind: "restored", status: "public", dismissed: 2, served: true });
    for (const body of [
      null,
      "ok",
      {},
      { status: "public", dismissed: 2 },
      { status: "public", dismissed: "2", served: true },
      { status: 1, dismissed: 2, served: true },
    ]) {
      expect(readRestoreReply(200, body)).toEqual({ kind: "failed", detail: "200" });
    }
  });

  it("R-mo.A7-3 401 は signed_out、403 は forbidden、404 は not_found、409 は invalid_state。本文の error が合うときだけ", () => {
    expect(readRestoreReply(401, { error: "unauthorized" })).toEqual({ kind: "signed_out" });
    expect(readRestoreReply(403, { error: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(readRestoreReply(404, { error: "not_found" })).toEqual({ kind: "not_found" });
    expect(readRestoreReply(409, { error: "invalid_state" })).toEqual({ kind: "invalid_state" });
    // 別のもの（プロキシや Vercel）が返した同じ状態は、API の答えとして読まない
    expect(readRestoreReply(404, null)).toEqual({ kind: "failed", detail: "404" });
    expect(readRestoreReply(403, { error: "other" })).toEqual({
      kind: "failed",
      detail: "403 other",
    });
  });

  it("R-mo.A7-3 それ以外は failed。error と、足りない変数名があれば添える", () => {
    expect(
      readRestoreReply(503, { error: "not_configured", missing: ["KV_NAMESPACE_ID"] }),
    ).toEqual({ kind: "failed", detail: "503 not_configured（KV_NAMESPACE_ID）" });
    expect(readRestoreReply(400, { error: "invalid_request" })).toEqual({
      kind: "failed",
      detail: "400 invalid_request",
    });
    expect(readRestoreReply(500, null)).toEqual({ kind: "failed", detail: "500" });
  });
});

describe("restoreText（結果の文面）", () => {
  const restored = (status: string, dismissed: number, served: boolean) =>
    restoreText({ kind: "restored", status, dismissed, served });

  it("R-mo.A7-3 解けたら投稿状態と退けた通報の数を伝える", () => {
    expect(restored("public", 2, true)).toBe(
      "制限を解きました。いまの状態: 公開（public）。退けた通報: 2 件。",
    );
    expect(restored("limited", 0, true)).toBe(
      "制限を解きました。いまの状態: 限定公開（limited）。退けた通報: 0 件。",
    );
  });

  it("R-mo.A7-3 ツリー制限が残る・作者が非公開にしている投稿は、まだ見えないことを伝える", () => {
    expect(restored("restricted", 1, true)).toContain(
      "個別の制限は解きましたが、ツリー制限が残っているので、まだ見えません",
    );
    expect(restored("unpublished", 1, true)).toContain(
      "作者が非公開にしているので、作者が再公開するまで見えません",
    );
  });

  it("R-mo.A7-3 served: false は、配信がまだ戻っていないことと、もう一度押すことを伝える", () => {
    const text = restored("public", 2, false);
    expect(text).toContain("制限を解きました");
    expect(text).toContain(
      "配信にはまだ反映されていません。もう一度「制限を解く」を押してください",
    );
    expect(restored("public", 2, true)).not.toContain("反映されていません");
  });

  it("R-mo.A7-3 解けなかった理由を区別して伝える", () => {
    expect(restoreText({ kind: "forbidden" })).toBe("このアカウントでは使えません。");
    expect(restoreText({ kind: "not_found" })).toBe("この ID の投稿はありません。");
    expect(restoreText({ kind: "invalid_state" })).toBe(
      "この投稿は下書きか削除済みなので、解く対象ではありません。",
    );
    expect(restoreText({ kind: "failed", detail: "500" })).toBe(
      "解けませんでした（500）。もう一度押してください。",
    );
    expect(restoreText({ kind: "signed_out" })).toBe("ログインが必要です。");
  });
});
