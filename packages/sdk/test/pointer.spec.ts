// pointer イベント → 入力（gc#A.4、R-gc.A4-2）。座標は 0〜1 に正規化済みのものを渡す。
import { describe, expect, it } from "vitest";
import { createPointerInput, normalize, quantize } from "../src/pointer.ts";

function setup(kind: Parameters<typeof createPointerInput>[0]) {
  const out: [string, number[]][] = [];
  const p = createPointerInput(kind, (k, data) => out.push([k, data]));
  return { p, out };
}

describe("座標", () => {
  it("normalize は画面に対する 0〜1 にし、範囲外は端に寄せる", () => {
    expect(normalize(100, 400)).toBe(0.25);
    expect(normalize(-5, 400)).toBe(0);
    expect(normalize(500, 400)).toBe(1);
    expect(normalize(10, 0)).toBe(0);
  });

  it("quantize は 1/256 刻みに丸める", () => {
    expect(quantize(0)).toBe(0);
    expect(quantize(1)).toBe(1);
    expect(quantize(0.5)).toBe(0.5);
    expect(quantize(0.3)).toBe(77 / 256);
    expect((quantize(0.123456) * 256) % 1).toBe(0);
  });
});

describe("tap", () => {
  it("押して離したときに [x, y]（押した位置）が 1 回出る", () => {
    const { p, out } = setup("tap");
    p.down(1, 0.25, 0.5);
    expect(out).toEqual([]);
    p.move(1, 0.3, 0.5);
    p.up(1, 0.3, 0.55);
    expect(out).toEqual([["tap", [0.25, 0.5]]]);
  });

  it("cancel では出ない。2 本目の指は無視する", () => {
    const { p, out } = setup("tap");
    p.down(1, 0.1, 0.1);
    p.down(2, 0.9, 0.9);
    p.up(2, 0.9, 0.9);
    p.cancel(1);
    expect(out).toEqual([]);
    p.down(3, 0.2, 0.2);
    p.up(3, 0.2, 0.2);
    expect(out).toEqual([["tap", [0.2, 0.2]]]);
  });
});

describe("hold", () => {
  it("押した瞬間に [x, y, 1]、離した瞬間に [x, y, 0]", () => {
    const { p, out } = setup("hold");
    p.down(1, 0.5, 0.5);
    p.move(1, 0.6, 0.6);
    p.up(1, 0.7, 0.8);
    expect(out).toEqual([
      ["hold", [0.5, 0.5, 1]],
      ["hold", [0.7, 0.8, 0]],
    ]);
  });

  it("cancel は最後の位置で離した扱いにする（押しっぱなしにしない）", () => {
    const { p, out } = setup("hold");
    p.down(1, 0.5, 0.5);
    p.move(1, 0.6, 0.6);
    p.cancel(1);
    expect(out.at(-1)).toEqual(["hold", [0.6, 0.6, 0]]);
  });
});

describe("swipe", () => {
  it("離した瞬間に始点と終点 [x0, y0, x1, y1]", () => {
    const { p, out } = setup("swipe");
    p.down(1, 0.2, 0.8);
    p.move(1, 0.5, 0.5);
    p.up(1, 0.9, 0.1);
    expect(out).toEqual([["swipe", [0.2, 0.8, 0.9, 0.1]]]);
  });

  it("cancel では出ない", () => {
    const { p, out } = setup("swipe");
    p.down(1, 0.2, 0.8);
    p.cancel(1);
    expect(out).toEqual([]);
  });
});

describe("drag", () => {
  it("押している間は位置が変わるたび [x, y, 1]、離した瞬間に [x, y, 0]。1/256 に量子化", () => {
    const { p, out } = setup("drag");
    p.down(1, 0.3, 0.3);
    p.move(1, 0.3001, 0.3001); // 量子化すると同じ位置なので出ない
    p.move(1, 0.5, 0.5);
    p.up(1, 0.75, 0.25);
    expect(out).toEqual([
      ["drag", [77 / 256, 77 / 256, 1]],
      ["drag", [0.5, 0.5, 1]],
      ["drag", [0.75, 0.25, 0]],
    ]);
  });

  it("押していない間の move と、別の指の move は無視する", () => {
    const { p, out } = setup("drag");
    p.move(1, 0.5, 0.5);
    p.down(1, 0.5, 0.5);
    p.move(2, 0.9, 0.9);
    p.up(2, 0.9, 0.9);
    expect(out).toEqual([["drag", [0.5, 0.5, 1]]]);
  });
});

describe("stick と未対応の種別", () => {
  it("stick はまだ入力を出さない（別 Issue）", () => {
    const { p, out } = setup("stick");
    p.down(1, 0.5, 0.5);
    p.move(1, 0.6, 0.6);
    p.up(1, 0.6, 0.6);
    expect(out).toEqual([]);
  });
});
