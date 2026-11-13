// 配信時に注入するバンドル（gc#A.4）。生成物が最新であることと、IIFE 単体で動くことを見る。
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildGuestBundle, GEN_PATH, genSource } from "../scripts/bundle.ts";
import { GUEST_SDK_JS } from "../src/guest-bundle.gen.ts";
import { fakeWindow } from "./fake-window.ts";

describe("Guest SDK のバンドル", () => {
  it("guest-bundle.gen.ts は現在のソースから作ったものと一致する。ずれたら `pnpm --filter @gamefeed/sdk gen:bundle`", async () => {
    expect(readFileSync(GEN_PATH, "utf8")).toBe(genSource(await buildGuestBundle()));
  });

  it("インラインの <script> に入れても壊れない（</script と <!-- を含まず、ASCII だけ）", () => {
    expect(GUEST_SDK_JS.toLowerCase()).not.toContain("</script");
    expect(GUEST_SDK_JS).not.toContain("<!--");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII の範囲を見る
    expect(/^[\x00-\x7f]*$/.test(GUEST_SDK_JS)).toBe(true);
    expect(GUEST_SDK_JS.length).toBeLessThan(40_000);
  });

  it("バンドル単体を実行すると window.GF ができ、ready → init → start → end まで動く", () => {
    const f = fakeWindow();
    vm.runInNewContext(GUEST_SDK_JS, { window: f.win });
    const GF = f.win.GF as { onTick(cb: () => void): void; score: number };
    GF.onTick(() => {
      GF.score += 2;
    });
    f.loaded();
    f.fromHost({
      type: "init",
      session_id: "s-1",
      seed: 7,
      mode: "play",
      time_limit: 12,
      speed: 1.5,
    });
    f.fromHost({ type: "start" });
    for (let i = 0; i < 20; i++) f.step(17);
    expect(f.sent.map((m) => m.type)).toEqual(["ready", "log", "end"]);
    expect(f.sent.at(-1)).toEqual({ type: "end", session_id: "s-1", score: 24, frames: 12 });
  });
});
