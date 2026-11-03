import { describe, expect, it } from "vitest";
import { DOMAIN_VERSION } from "../src/index.ts";

describe("smoke", () => {
  it("domain パッケージが読み込める", () => {
    expect(DOMAIN_VERSION).toBe("0.0.0");
  });
});
