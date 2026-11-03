import { describe, expect, it } from "vitest";
import worker, { CSP } from "../src/index.ts";

describe("smoke", () => {
  it("未知のパスは 404 で、CSP ヘッダが付く", async () => {
    const res = await worker.fetch(new Request("https://x.games.example/"), { GAMES: {} as never });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
  });
});
