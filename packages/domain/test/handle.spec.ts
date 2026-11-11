import { describe, expect, it } from "vitest";
import { HANDLE_MAX, HANDLE_MIN, handleBase, handleCandidate } from "../src/index.ts";

// mc#A.5: auth_user.name を slug 化して users.handle を作る
describe("R-mc.A5-1 handle の生成（mc#A.5）", () => {
  const id = "01JCABCDEFGHJKMNPQRSTVWXYZ";

  it.each([
    ["Taku Sakuma", "taku-sakuma"],
    ["  Taku   Sakuma  ", "taku-sakuma"],
    ["TAKU_sakuma.01", "taku-sakuma-01"],
    // NFKC: 全角英数は半角に
    ["Ｔａｋｕ　１２３", "taku-123"],
    // 連続する記号は 1 つの - に、前後の - は除く
    ["--a!!b??c--", "a-b-c"],
    // ラテン以外が混ざっていれば残った部分を使う
    ["佐久間 Takuya", "takuya"],
    ["abc", "abc"],
  ])("R-mc.A5-1 %j → %j", (name, expected) => {
    expect(handleBase(name, id)).toBe(expected);
  });

  it.each([["佐久間"], ["a"], ["ab"], [""], ["!!!"], ["佐 a 久"]])(
    "R-mc.A5-1 %j は 3 文字未満・空なので user-<id 末尾 6 文字（小文字）>",
    (name) => {
      expect(handleBase(name, id)).toBe("user-tvwxyz");
    },
  );

  it("R-mc.A5-1 20 文字に切り、切った後ろの - も除く", () => {
    expect(handleBase("abcdefghijklmnopqrstuvwxyz", id)).toBe("abcdefghijklmnopqrst");
    // 20 文字目がちょうど - になる
    expect(handleBase("abcdefghijklmnopqrs tuv", id)).toBe("abcdefghijklmnopqrs");
    expect(HANDLE_MIN).toBe(3);
    expect(HANDLE_MAX).toBe(20);
  });

  it("R-mc.A5-1 衝突したら -2, -3, … を付ける", () => {
    expect(handleCandidate("taku-sakuma", 1)).toBe("taku-sakuma");
    expect(handleCandidate("taku-sakuma", 2)).toBe("taku-sakuma-2");
    expect(handleCandidate("taku-sakuma", 3)).toBe("taku-sakuma-3");
    expect(handleCandidate("taku-sakuma", 12)).toBe("taku-sakuma-12");
  });

  it("R-mc.A5-1 接尾辞で 20 文字を超えるなら元を縮める", () => {
    const base = "abcdefghijklmnopqrst";
    expect(handleCandidate(base, 2)).toBe("abcdefghijklmnopqr-2");
    expect(handleCandidate(base, 10)).toBe("abcdefghijklmnopq-10");
    // 縮めた末尾が - なら除く
    expect(handleCandidate("abcdefghijklmnopq-rs", 2)).toBe("abcdefghijklmnopq-2");
    for (const n of [2, 9, 10, 99, 100]) {
      expect(handleCandidate(base, n).length).toBeLessThanOrEqual(HANDLE_MAX);
    }
  });

  it("R-mc.A5-1 生成した handle は常に [a-z0-9-] の 3〜20 文字で、前後が - でない", () => {
    const names = ["Taku Sakuma", "佐久間", "x", "A".repeat(50), "a-b", "é à ü", "1 2 3", "😀😀😀"];
    for (const name of names) {
      for (const n of [1, 2, 37]) {
        const h = handleCandidate(handleBase(name, id), n);
        expect(h).toMatch(/^[a-z0-9](?:[a-z0-9-]{1,18})[a-z0-9]$/);
      }
    }
  });
});
