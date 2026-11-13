// R-5.1-3: ゲーム URL の組み立ては Host の 1 関数に閉じる（se#A.2、A.3）。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gameUrl } from "../src/game-url.ts";

const ORIGIN = "https://gamefeed-games.example.workers.dev";
const ID = "01M782MV00TMYMTHTGG5C6KS3T";

describe("gameUrl", () => {
  it("公開済みは <games-origin>/p/<post_id>/（末尾スラッシュつき）", () => {
    expect(gameUrl(ORIGIN, ID)).toBe(`${ORIGIN}/p/${ID}/`);
    expect(gameUrl(`${ORIGIN}/`, ID)).toBe(`${ORIGIN}/p/${ID}/`);
  });

  it("下書きの試遊は ?t=<試遊トークン> を付ける", () => {
    expect(gameUrl(ORIGIN, ID, "abc_-.def")).toBe(`${ORIGIN}/p/${ID}/?t=abc_-.def`);
    expect(gameUrl(ORIGIN, ID, "a b&c")).toBe(`${ORIGIN}/p/${ID}/?t=a%20b%26c`);
  });

  it("post_id が ULID の形でなければ例外（パスを組み立てない）", () => {
    for (const bad of ["", "abc", "../x", `${ID}/`, ID.toLowerCase(), `${ID}?x=1`]) {
      expect(() => gameUrl(ORIGIN, bad), bad).toThrow();
    }
  });

  it("配信オリジンが https の URL でなければ例外（ローカルの http://localhost は可）", () => {
    for (const bad of [
      "",
      "gamefeed.example",
      "javascript:alert(1)",
      "http://evil.example",
      "https://a.example/path",
    ]) {
      expect(() => gameUrl(bad, ID), bad).toThrow();
    }
    expect(gameUrl("http://localhost:8787", ID)).toBe(`http://localhost:8787/p/${ID}/`);
  });

  it("R-5.1-3: apps/web/src で /p/ を組み立てているのは game-url.ts だけ", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const offenders = files.filter(
      (f) =>
        f !== "game-url.ts" &&
        /["'`/]\/?p\/\$\{|\/p\/["'`]/.test(readFileSync(join(src, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
