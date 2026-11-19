// device_id（dm#A.1、se#A.2、#161 の 1）: localStorage に置く 128 bit の乱数。
import { describe, expect, it } from "vitest";
import { DEVICE_ID_KEY, deviceId } from "../src/run/device-id.ts";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

/** 0, 1, 2, … で埋める乱数 */
const counting = (bytes: Uint8Array) => {
  bytes.forEach((_, i) => {
    bytes[i] = i;
  });
  return bytes;
};

describe("deviceId", () => {
  it("初回は 128 bit の乱数を base64url 22 文字で作って保存する。サーバの形（22〜64 文字の [A-Za-z0-9_-]）に合う", () => {
    const storage = memory();
    const id = deviceId(storage, counting);
    expect(id).toBe("AAECAwQFBgcICQoLDA0ODw");
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(storage.data.get(DEVICE_ID_KEY)).toBe(id);
  });

  it("2 回目以降は保存した値を返す（乱数を引かない）", () => {
    const storage = memory({ [DEVICE_ID_KEY]: "abcdefghijklmnopqrstuv" });
    const id = deviceId(storage, () => {
      throw new Error("乱数を引いた");
    });
    expect(id).toBe("abcdefghijklmnopqrstuv");
  });

  it("保存した値が形に合わなければ作り直す", () => {
    for (const bad of ["", "short", "has space in the middle!!", "a".repeat(65)]) {
      const storage = memory({ [DEVICE_ID_KEY]: bad });
      const id = deviceId(storage, counting);
      expect(id, bad).toBe("AAECAwQFBgcICQoLDA0ODw");
      expect(storage.data.get(DEVICE_ID_KEY)).toBe(id);
    }
  });

  it("ストレージが使えなくても（例外）値は返す。保存はできない", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(deviceId(broken, counting)).toBe("AAECAwQFBgcICQoLDA0ODw");
  });
});
