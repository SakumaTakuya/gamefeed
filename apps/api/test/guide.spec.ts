import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractGuide } from "../src/guide.ts";
import { GUIDE_MARKDOWN } from "../src/guide.gen.ts";

// mc#A.3: gf://guide は game-contract.md の A 部（A.1〜A.13）の本文
describe("R-mc.A3-1 gf://guide の本文", () => {
  const contract = readFileSync(
    fileURLToPath(new URL("../../../docs/game-contract.md", import.meta.url)),
    "utf8",
  );

  it("取り込み済みの本文（guide.gen.ts）はリポジトリの game-contract.md の A 部と一致する。ずれたら `pnpm --filter @gamefeed/api gen:guide`", () => {
    expect(GUIDE_MARKDOWN).toBe(extractGuide(contract));
  });

  it("A 部は「# A. 規約」から始まり、A.1〜A.13 を含み、B 部と区切り線を含まない", () => {
    const guide = extractGuide(contract);
    expect(guide.startsWith("# A. 規約\n")).toBe(true);
    for (let i = 1; i <= 13; i++) expect(guide).toContain(`\n## A.${i} `);
    expect(guide).not.toContain("# B.");
    expect(guide).not.toContain("## B.1");
    expect(guide.endsWith("\n")).toBe(true);
    expect(guide.trimEnd().endsWith("---")).toBe(false);
  });

  it("A 部や B 部の見出しがない文書は失敗する（黙って空を返さない）", () => {
    expect(() => extractGuide("# 何か\n\n本文\n")).toThrow();
    expect(() => extractGuide("# A. 規約\n\n本文だけで B 部がない\n")).toThrow();
  });
});
