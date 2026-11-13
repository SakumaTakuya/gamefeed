// ブラウザへの組み込み（gc#A.3〜A.5、protocol#A.1）。DOM は test/fake-window.ts の最小の偽物。
import { describe, expect, it } from "vitest";
import { installGuest, VIEWPORT } from "../src/browser.ts";
import type { GF } from "../src/guest.ts";
import { fakeWindow } from "./fake-window.ts";

const INIT = { type: "init", session_id: "s-1", seed: 1, mode: "play", time_limit: 300, speed: 1 };

function install(opts: Parameters<typeof fakeWindow>[0] = {}) {
  const f = fakeWindow(opts);
  installGuest(f.win as unknown as Window);
  return { ...f, GF: f.win.GF as GF };
}

describe("installGuest", () => {
  it("window.GF を置き、文書を読み終えたらメタ宣言で ready を送る", () => {
    const f = install();
    expect(typeof f.GF.onTick).toBe("function");
    expect(f.sent).toEqual([]);
    f.loaded();
    expect(f.sent).toEqual([
      {
        type: "ready",
        sdk: "2.0",
        title: "まるタップ",
        verb: "タップ！",
        input: "tap",
        duration: 300,
        target: 12,
      },
    ]);
  });

  it("読み終えた後に入っても ready を送る", () => {
    const f = install({ readyState: "complete" });
    expect(f.sent.map((m) => m.type)).toEqual(["ready"]);
  });

  it("window.GF は書き換えられない", () => {
    const f = install();
    const before = f.win.GF;
    expect(() => {
      "use strict";
      (f.win as { GF: unknown }).GF = {};
    }).toThrow();
    expect(f.win.GF).toBe(before);
  });

  it("viewport は SDK のものに置き換える（ゲームが書いたものは消す）", () => {
    const f = install({
      metas: {
        viewport: "width=1000",
        "gf:verb": "よけろ",
        "gf:input": "drag",
        "gf:duration": "180",
        "gf:target": "3",
      },
    });
    f.loaded();
    expect(f.metas.filter((m) => m.name === "viewport").map((m) => m.content)).toEqual([VIEWPORT]);
    expect(f.doc.documentElement.style.touchAction).toBe("none");
  });

  it("親から届いたメッセージだけを受ける（protocol#A.1）", () => {
    const f = install();
    let inits = 0;
    f.GF.onInit(() => inits++);
    f.loaded();
    f.win.dispatch("message", { source: {}, data: INIT });
    f.win.dispatch("message", { source: f.win, data: INIT });
    expect(inits).toBe(0);
    f.fromHost(INIT);
    expect(inits).toBe(1);
  });

  it("rAF ごとに進み、pointer を 0〜1 の座標の入力にして、end まで届く", () => {
    const f = install();
    const inputs: unknown[] = [];
    f.GF.onInput((ev) => {
      inputs.push([ev.frame, ev.kind, ev.data]);
      f.GF.score += 1;
    });
    f.loaded();
    f.fromHost({ ...INIT, time_limit: 30 });
    f.fromHost({ type: "start" });
    f.step(17);
    f.pointer("pointerdown", 100, 200);
    f.pointer("pointerup", 100, 200);
    for (let i = 0; i < 40; i++) f.step(17);
    expect(inputs).toEqual([[1, "tap", [0.25, 0.25]]]);
    expect(f.sent.map((m) => m.type)).toEqual(["ready", "log", "end"]);
    expect(f.sent.at(-1)).toEqual({ type: "end", session_id: "s-1", score: 1, frames: 30 });
  });

  it("pointerdown で指を捕まえる（iframe の外で離しても pointerup が届く）。失敗しても入力は続く", () => {
    const f = install({
      metas: { "gf:verb": "おせ", "gf:input": "hold", "gf:duration": "300", "gf:target": "1" },
    });
    const inputs: number[][] = [];
    f.GF.onInput((ev) => inputs.push(ev.data));
    f.loaded();
    f.fromHost(INIT);
    f.fromHost({ type: "start" });
    f.pointer("pointerdown", 200, 400, 7);
    f.pointer("pointerup", 200, 400, 7);
    f.pointer("pointerdown", 200, 400, -1); // 捕まえるのに失敗する指
    f.step(17);
    expect(f.doc.documentElement.captured).toEqual([7]);
    expect(inputs).toEqual([
      [0.5, 0.5, 1],
      [0.5, 0.5, 0],
      [0.5, 0.5, 1],
    ]);
  });

  it("ゲームが performance.now や requestAnimationFrame を差し替えても、SDK はつかんだ実体で進む", () => {
    const f = install();
    let ticks = 0;
    f.GF.onTick(() => ticks++);
    f.loaded();
    f.win.performance.now = () => 0;
    f.win.requestAnimationFrame = () => 0;
    f.fromHost(INIT);
    f.fromHost({ type: "start" });
    f.step(50);
    f.step(50);
    expect(ticks).toBe(6);
  });

  it("直接開かれたとき（親がいない）は何も送らず、メッセージも受けない", () => {
    const f = install({ topLevel: true });
    let inits = 0;
    f.GF.onInit(() => inits++);
    f.loaded();
    f.win.dispatch("message", { source: f.win, data: INIT });
    expect(f.sent).toEqual([]);
    expect(inits).toBe(0);
  });
});
