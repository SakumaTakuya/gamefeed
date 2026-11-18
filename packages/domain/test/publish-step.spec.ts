import { describe, expect, it } from "vitest";
import {
  type PublishBase,
  type PublishStep,
  type PublishTarget,
  publishStep,
  sameContentTarget,
} from "../src/index.ts";

const BASES: PublishBase[] = ["draft", "limited", "public", "unpublished", "removed"];
const PUBLISHED: PublishBase[] = ["limited", "public", "unpublished"];

// mc#A.7 の表。verification/Publish.tla の Tx（G1・G4・G7・G8）と同じ規則
describe("R-mc.A7-1 publish_game が対象の投稿にすること（mc#A.7）", () => {
  // 表の全組み合わせ: 対象なし 1 + post_id（5 状態 × 同じ / 違う）10 + 同一内容で見つけた 5 = 16
  const table: [PublishTarget, PublishStep][] = [
    [{ by: "none" }, "create"],
    [{ by: "post_id", base: "draft", sameContent: true }, "replace"],
    [{ by: "post_id", base: "draft", sameContent: false }, "replace"],
    [{ by: "post_id", base: "limited", sameContent: true }, "keep"],
    [{ by: "post_id", base: "limited", sameContent: false }, "immutable"],
    [{ by: "post_id", base: "public", sameContent: true }, "keep"],
    [{ by: "post_id", base: "public", sameContent: false }, "immutable"],
    [{ by: "post_id", base: "unpublished", sameContent: true }, "keep"],
    [{ by: "post_id", base: "unpublished", sameContent: false }, "immutable"],
    [{ by: "post_id", base: "removed", sameContent: true }, "removed"],
    [{ by: "post_id", base: "removed", sameContent: false }, "removed"],
    [{ by: "content", base: "draft" }, "refresh"],
    [{ by: "content", base: "limited" }, "keep"],
    [{ by: "content", base: "public" }, "keep"],
    [{ by: "content", base: "unpublished" }, "keep"],
    [{ by: "content", base: "removed" }, "removed"],
  ];

  it.each(table)("R-mc.A7-1 %j → %s", (target, step) => {
    expect(publishStep(target)).toBe(step);
  });

  it("R-mc.A7-1 表は全組み合わせを尽くす（16 通り、重複なし）", () => {
    const all: PublishTarget[] = [
      { by: "none" },
      ...BASES.flatMap((base): PublishTarget[] => [
        { by: "post_id", base, sameContent: true },
        { by: "post_id", base, sameContent: false },
        { by: "content", base },
      ]),
    ];
    const keys = new Set(table.map(([t]) => JSON.stringify(t)));
    expect(keys.size).toBe(table.length);
    expect(new Set(all.map((t) => JSON.stringify(t)))).toEqual(keys);
  });

  it("R-mc.A7-1 公開後の投稿の内容を変える結果（replace）は、どの入力からも出ない（dm#A.5 I10）", () => {
    for (const base of PUBLISHED) {
      for (const sameContent of [true, false]) {
        expect(publishStep({ by: "post_id", base, sameContent })).not.toBe("replace");
      }
      expect(publishStep({ by: "content", base })).toBe("keep");
    }
  });

  it("R-mc.A7-1 同じ内容の呼び直しは removed 以外で拒まれない（#97、Publish.tla の G1）", () => {
    for (const base of BASES.filter((b) => b !== "removed")) {
      const steps = [
        publishStep({ by: "post_id", base, sameContent: true }),
        publishStep({ by: "content", base }),
      ];
      for (const s of steps) expect(["replace", "refresh", "keep"]).toContain(s);
    }
  });
});

describe("R-mc.A7-1 同一内容で見つけた投稿の選び方（mc#A.7 の補足）", () => {
  it("R-mc.A7-1 同じ内容の投稿がなければ対象なし", () => {
    expect(sameContentTarget([])).toEqual({ by: "none" });
  });

  it("R-mc.A7-1 updated_at が最も新しい投稿（先頭）を選ぶ", () => {
    const posts = [
      { id: "b", base: "draft" as const },
      { id: "a", base: "limited" as const },
    ];
    expect(sameContentTarget(posts)).toEqual({ by: "content", base: "draft", post: posts[0] });
  });

  it("R-mc.A7-1 removed が 1 つでもあれば、新しい投稿があっても removed", () => {
    const posts = [
      { id: "b", base: "draft" as const },
      { id: "a", base: "removed" as const },
    ];
    const t = sameContentTarget(posts);
    expect(t).toMatchObject({ by: "content", base: "removed" });
    expect(publishStep(t)).toBe("removed");
  });
});
