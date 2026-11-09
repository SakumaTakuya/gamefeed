import { describe, expect, it } from "vitest";
import { SDK_PROTOCOL_VERSION } from "../src/index.ts";

describe("smoke", () => {
  it("sdk パッケージが読み込める", () => {
    expect(SDK_PROTOCOL_VERSION).toBe("2.0");
  });
});
