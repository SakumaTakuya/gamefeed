import { describe, expect, it } from "vitest";
import { buildEndlessDeck, DECK_RECENT_DAYS, type DeckCandidate } from "../src/deck.ts";
import { ENDLESS_DECK_SIZE } from "../src/run-record.ts";

/** seed から決まる乱数（mulberry32）。テストの山札を再現できるようにする */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normal = (n: number, drawnAt: (i: number) => number | null = () => null): DeckCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ postId: `c${i}`, kind: "normal", drawnAt: drawnAt(i) }));
const fresh = (n: number, drawnAt: (i: number) => number | null = () => null): DeckCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ postId: `u${i}`, kind: "new", drawnAt: drawnAt(i) }));

function build(candidates: DeckCandidate[], seed = 1) {
  const built = buildEndlessDeck(candidates, rng(seed));
  if (!built) throw new Error("山札が組めなかった");
  return built;
}
const newPosts = (d: { deck: string[]; newIndexes: number[] }) =>
  d.newIndexes.map((i) => d.deck[i]);

describe("エンドレスの山札（run#A.2、A.10、sc#A.8）", () => {
  it("定数: 直近 7 日に引いたものを除く（暫定）", () => {
    expect(DECK_RECENT_DAYS).toBe(7);
    expect(ENDLESS_DECK_SIZE).toBe(12);
  });

  it("R-sc.A8-1 校正済み 20・未校正 20 なら、校正済み 11 本 + 新作枠 1 本", () => {
    const d = build([...normal(20), ...fresh(20)]);
    expect(d.deck).toHaveLength(12);
    expect(d.newIndexes).toHaveLength(1);
    expect(d.deck.filter((p) => p.startsWith("c"))).toHaveLength(11);
    expect(newPosts(d)[0]).toMatch(/^u/);
  });

  // 校正済み 0 / 5 / 11 / 20 本 × 未校正 0 / 1 / 20 本（#123 の表）
  it.each([
    [0, 1, 1, 1],
    [0, 20, 12, 12],
    [5, 0, 5, 0],
    [5, 1, 6, 1],
    [5, 20, 12, 7],
    [11, 0, 11, 0],
    [11, 1, 12, 1],
    [11, 20, 12, 1],
    [20, 0, 12, 0],
    [20, 1, 12, 1],
    [20, 20, 12, 1],
  ])("R-sc.A8-1 校正済み %i 本・未校正 %i 本 → 山札 %i 本、新作扱い %i 本", (c, u, size, news) => {
    for (let seed = 1; seed <= 20; seed++) {
      const d = build([...normal(c), ...fresh(u)], seed);
      expect(d.deck).toHaveLength(size);
      expect(d.newIndexes).toHaveLength(news);
      // 新作扱いの位置は未校正のゲームと一致し、昇順で重複がない
      expect(d.deck.map((p, i) => (p.startsWith("u") ? i : -1)).filter((i) => i >= 0)).toEqual(
        d.newIndexes,
      );
      // 同じゲームを山札に重ねない
      expect(new Set(d.deck).size).toBe(d.deck.length);
    }
  });

  it("R-sc.A8-1 出せるゲームが 0 本なら null（API は 409 no_games）", () => {
    expect(buildEndlessDeck([], rng(1))).toBeNull();
  });

  it("新作枠の位置は山札の中でランダム（run#A.10）", () => {
    const positions = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) {
      const [i] = build([...normal(20), ...fresh(3)], seed).newIndexes;
      positions.add(i as number);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("同じ乱数なら同じ山札、乱数が違えば抽選も並びも変わる", () => {
    const pool = [...normal(40), ...fresh(5)];
    expect(build(pool, 7)).toEqual(build(pool, 7));
    const decks = new Set(Array.from({ length: 20 }, (_, i) => build(pool, i + 1).deck.join(",")));
    expect(decks.size).toBeGreaterThan(15);
  });

  it("候補に同じ post_id が重なっていても山札には 1 回", () => {
    const d = build([...normal(3), ...normal(3)]);
    expect([...d.deck].sort()).toEqual(["c0", "c1", "c2"]);
  });

  describe("直近に引いたゲームの除外", () => {
    it("12 本組めるなら、直近に引いたものは入らない", () => {
      // c0〜c7 は直近に引いた。残り 12 本 + 未校正 1 本で組める
      const pool = [
        ...normal(19, (i) => (i < 8 ? 1000 + i : null)),
        ...fresh(2, (i) => (i === 0 ? 5 : null)),
      ];
      for (let seed = 1; seed <= 20; seed++) {
        const d = build(pool, seed);
        expect(d.deck).toHaveLength(12);
        expect(d.deck.filter((p) => /^c[0-7]$/.test(p))).toEqual([]);
        expect(newPosts(d)).toEqual(["u1"]);
      }
    });

    it("12 本に足りなければ、引いた日が古いものから除外を外す", () => {
      // 引いていないのは c0〜c8 の 9 本。足りない 3 本は古い順に c9（100）、u0（200）、c10（300）
      const pool = [
        ...normal(14, (i) => (i < 9 ? null : ([100, 300, 500, 400, 600][i - 9] as number))),
        ...fresh(1, () => 200),
      ];
      for (let seed = 1; seed <= 20; seed++) {
        const d = build(pool, seed);
        expect([...d.deck].sort()).toEqual(
          ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "u0"].sort(),
        );
        expect(newPosts(d)).toEqual(["u0"]);
      }
    });

    it("全部引いたばかりでも、あるだけで組む（短くするより除外を外す）", () => {
      const d = build([...normal(5, (i) => i), ...fresh(1, () => 9)]);
      expect(d.deck).toHaveLength(6);
      expect(d.newIndexes).toHaveLength(1);
    });

    it("12 本組めるなら、新作枠が空でも除外は外さない", () => {
      // 未校正は直近に引いた 1 本だけ。校正済みは 12 本引いていない
      const d = build([...normal(12), ...fresh(1, () => 1)]);
      expect(d.deck).toHaveLength(12);
      expect(d.newIndexes).toEqual([]);
    });
  });
});
