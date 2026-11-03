import { SDK_PROTOCOL_VERSION } from "@gamefeed/sdk";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("web から workspace パッケージを解決できる", () => {
    expect(SDK_PROTOCOL_VERSION).toBe("1.1");
  });
});
