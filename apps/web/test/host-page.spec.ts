// Host のページが拡大されないための指定（#190）。実機の挙動は manual（docs/manual-tests/run-tempo.md の RT-7）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_STAGE } from "../src/host-stage.ts";

describe("Host のページの拡大を止める（#190）", () => {
  it("index.html の viewport は拡大を許さない（Guest に SDK が入れるものと同じ。gc#A.2）", () => {
    const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
    const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(viewport.split(",").map((s) => s.trim())).toEqual([
      "width=device-width",
      "initial-scale=1",
      "maximum-scale=1",
      "user-scalable=no",
      "viewport-fit=cover",
    ]);
  });

  it("画面の枠は touch-action: manipulation（ダブルタップ拡大を止め、スクロールは残す）で、選択と長押しのメニューを出さない", () => {
    expect(HOST_STAGE).toMatchObject({
      touchAction: "manipulation",
      userSelect: "none",
      WebkitUserSelect: "none",
      WebkitTouchCallout: "none",
    });
  });

  it("ラン画面・試遊ページ・ゲームページの枠がこの指定を使う", () => {
    for (const file of ["run/RunPage.tsx", "draft/DraftPage.tsx", "game/GamePage.tsx"]) {
      const src = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
      expect(src, file).toMatch(/stage: \{\s*\.\.\.HOST_STAGE,/);
    }
  });
});
