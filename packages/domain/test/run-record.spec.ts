import { describe, expect, it } from "vitest";
import {
  DAILY_TURN_LIMIT,
  ENDLESS_DECK_SIZE,
  ENDLESS_LIVES,
  ENDLESS_TURN_LIMIT,
  nextTurn,
  type RecordedTurn,
  summarizeRun,
  turnSpeed,
} from "../src/index.ts";

/** 結果のある手番。既定は校正済みのゲームで閾値 10、点 50、偏差値 55 */
const played = (over: Partial<RecordedTurn> = {}): RecordedTurn => ({
  state: "submitted",
  via: "guest",
  score: 50,
  missBelow: 10,
  deviation: 55,
  ...over,
});
const miss = (): RecordedTurn => played({ score: 3, deviation: 35 });
const fresh = (): RecordedTurn => played({ missBelow: null, deviation: null });
const unsent = (missBelow: number | null = 10): RecordedTurn => ({
  state: "abandoned",
  via: null,
  score: null,
  missBelow,
  deviation: null,
});

describe("定数（run#A.2）", () => {
  it("文書の値", () => {
    expect(ENDLESS_DECK_SIZE).toBe(12);
    expect(ENDLESS_TURN_LIMIT).toBe(50);
    expect(DAILY_TURN_LIMIT).toBe(10);
    expect(ENDLESS_LIVES).toBe(3);
  });
});

describe("turnSpeed（R-run.A8-1、run#A.8）", () => {
  it("エンドレスは周回 k で min(1.5, 1 + 0.125k)", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((k) => turnSpeed("endless", k))).toEqual([
      1, 1.125, 1.25, 1.375, 1.5, 1.5, 1.5,
    ]);
  });

  it("デイリーは常に 1.0", () => {
    expect([0, 1, 5].map((k) => turnSpeed("daily", k))).toEqual([1, 1, 1]);
  });
});

describe("nextTurn（R-run.A3-1 の unit、run#A.2、A.3）", () => {
  it("山札 12 本: 手番 0〜11 が 1 周目、12 が 2 周目の先頭で速度が上がる", () => {
    expect(nextTurn("endless", 12, 0, 0)).toEqual({
      done: false,
      turn: 0,
      index: 0,
      lap: 0,
      speed: 1,
    });
    expect(nextTurn("endless", 12, 11, 0)).toEqual({
      done: false,
      turn: 11,
      index: 11,
      lap: 0,
      speed: 1,
    });
    expect(nextTurn("endless", 12, 12, 0)).toEqual({
      done: false,
      turn: 12,
      index: 0,
      lap: 1,
      speed: 1.125,
    });
    expect(nextTurn("endless", 12, 49, 0)).toEqual({
      done: false,
      turn: 49,
      index: 1,
      lap: 4,
      speed: 1.5,
    });
  });

  it("山札 12・上限 50 で 51 回目が done", () => {
    expect(nextTurn("endless", 12, 50, 0)).toEqual({ done: true });
  });

  it("ミスが 3 回なら done、2 回なら続く", () => {
    expect(nextTurn("endless", 12, 7, 2).done).toBe(false);
    expect(nextTurn("endless", 12, 7, 3)).toEqual({ done: true });
  });

  it("デイリーは 10 本で done。ミスの数は見ない。速度は 1.0", () => {
    expect(nextTurn("daily", 10, 9, 5)).toEqual({
      done: false,
      turn: 9,
      index: 9,
      lap: 0,
      speed: 1,
    });
    expect(nextTurn("daily", 10, 10, 0)).toEqual({ done: true });
  });

  it("短い山札（#123）は同じ規則で周回する", () => {
    expect(nextTurn("endless", 3, 7, 0)).toEqual({
      done: false,
      turn: 7,
      index: 1,
      lap: 2,
      speed: 1.25,
    });
    expect(nextTurn("endless", 1, 49, 0)).toEqual({
      done: false,
      turn: 49,
      index: 0,
      lap: 49,
      speed: 1.5,
    });
  });

  it("出せなくなった投稿を飛ばした後は、山札の通算位置（cursor）から位置と周回を出す（mo#A.3）", () => {
    // 手番 5 まで発行済み。途中で 2 本飛ばしたので、山札の通算位置は 7
    expect(nextTurn("endless", 12, 5, 0, 7)).toEqual({
      done: false,
      turn: 5,
      index: 7,
      lap: 0,
      speed: 1,
    });
    // 飛ばしたぶん、周回の境界は手番 12 より早く来る
    expect(nextTurn("endless", 12, 10, 0, 12)).toMatchObject({
      turn: 10,
      index: 0,
      lap: 1,
      speed: 1.125,
    });
  });

  it("デイリーは山札を 1 周したら done（飛ばして 9 手番になった日）", () => {
    expect(nextTurn("daily", 10, 9, 0, 10)).toEqual({ done: true });
    expect(nextTurn("daily", 10, 8, 0, 9)).toMatchObject({ turn: 8, index: 9 });
  });

  it("山札が空なら例外", () => {
    expect(() => nextTurn("endless", 0, 0, 0)).toThrow(RangeError);
  });
});

describe("summarizeRun: 到達手番数（R-run.A7-2、run#A.7、sc#A.9）", () => {
  it("ミスが 3 回に満たなければ、遊んだ手番数", () => {
    const s = summarizeRun("endless", [played(), miss(), played(), played()]);
    expect(s).toMatchObject({ reached: 4, misses: 1, ended: "abandoned" });
  });

  it("3 回目のミスが起きた手番までを数える", () => {
    const s = summarizeRun("endless", [played(), miss(), miss(), played(), miss()]);
    expect(s).toMatchObject({ reached: 5, misses: 3, ended: "lives" });
  });

  it("3 回目のミスの後に送られた結果は到達本数に入らない", () => {
    const s = summarizeRun("endless", [miss(), miss(), miss(), played(), played()]);
    expect(s).toMatchObject({ reached: 3, misses: 3, ended: "lives" });
    expect(s.turns.map((t) => t.kind)).toEqual(["miss", "miss", "miss", "dropped", "dropped"]);
  });

  it("3 回目のミスの結果を送らず次を送っても同じ（結果のない手番は、後ろに結果があればミス）", () => {
    const s = summarizeRun("endless", [miss(), miss(), unsent(), played(), played()]);
    expect(s).toMatchObject({ reached: 3, misses: 3, ended: "lives" });
  });

  it("先読みで発行したまま捨てた手番（最後の結果より後）は数えない", () => {
    const s = summarizeRun("endless", [played(), miss(), played(), unsent(), unsent()]);
    expect(s).toMatchObject({ reached: 3, misses: 1, ended: "abandoned" });
    expect(s.turns.map((t) => t.kind)).toEqual(["ok", "miss", "ok", "dropped", "dropped"]);
  });

  it("結果のない手番が新作枠・校正中（miss_below が null）なら skip として数える", () => {
    const s = summarizeRun("endless", [miss(), miss(), unsent(null), played()]);
    expect(s).toMatchObject({ reached: 4, misses: 2, ended: "abandoned" });
    expect(s.turns[2]?.kind).toBe("skip");
  });

  it("新作枠・校正中は点が低くてもミスにならない（F7）", () => {
    const s = summarizeRun("endless", [fresh(), played({ missBelow: null, score: 0 }), fresh()]);
    expect(s).toMatchObject({ reached: 3, misses: 0 });
  });

  it("timeout / error と skipped は skip。手番は消費するがミスにならない", () => {
    const s = summarizeRun("endless", [
      played({ via: "timeout", score: 0, deviation: 20 }),
      played({ via: "error", score: 0, deviation: 20 }),
      { state: "skipped", via: null, score: null, missBelow: 10, deviation: null },
      played(),
    ]);
    expect(s).toMatchObject({ reached: 4, misses: 0 });
    expect(s.turns.map((t) => t.kind)).toEqual(["skip", "skip", "skip", "ok"]);
  });

  it("score が miss_below ちょうどならミスではない", () => {
    expect(summarizeRun("endless", [played({ score: 10 })]).misses).toBe(0);
    expect(summarizeRun("endless", [played({ score: 9 })]).misses).toBe(1);
  });

  it("上限まで遊んだら ended は limit", () => {
    const turns = Array.from({ length: ENDLESS_TURN_LIMIT }, () => played());
    expect(summarizeRun("endless", turns)).toMatchObject({ reached: 50, ended: "limit" });
  });

  it("全手番 skip でも上限で終わる（R-run.A15-1、F6）", () => {
    let issued = 0;
    const turns: RecordedTurn[] = [];
    while (!nextTurn("endless", 12, issued, summarizeRun("endless", turns).misses).done) {
      turns.push(played({ via: "timeout", score: 0 }));
      issued++;
    }
    expect(issued).toBe(50);
    expect(summarizeRun("endless", turns)).toMatchObject({
      reached: 50,
      misses: 0,
      ended: "limit",
    });
  });

  it("結果が 1 つもなければ 0 本", () => {
    expect(summarizeRun("endless", [unsent(), unsent()])).toMatchObject({
      reached: 0,
      misses: 0,
      avgDeviation: null,
      ended: "abandoned",
    });
    expect(summarizeRun("endless", [])).toMatchObject({ reached: 0, ended: "abandoned" });
  });
});

describe("summarizeRun: 平均偏差値と記号列（sc#A.9）", () => {
  it("平均は偏差値のある手番だけ。小数 1 桁", () => {
    const s = summarizeRun("endless", [
      played({ deviation: 61.3 }),
      fresh(),
      played({ deviation: 48.2 }),
      played({ via: "timeout", score: 0, deviation: null }),
    ]);
    expect(s.avgDeviation).toBe(54.8);
  });

  it("捨てた手番の偏差値は平均に入らない", () => {
    const s = summarizeRun("endless", [miss(), miss(), miss(), played({ deviation: 80 })]);
    expect(s.avgDeviation).toBe(35);
  });

  it("平均がちょうど 0.05 の境界に乗るとき、浮動小数の誤差で切り下げない", () => {
    const s = summarizeRun("endless", [played({ deviation: 20.1 }), played({ deviation: 64.6 })]);
    expect(s.avgDeviation).toBe(42.4);
  });

  it("偏差値のある手番がなければ null", () => {
    expect(summarizeRun("endless", [fresh(), fresh()]).avgDeviation).toBeNull();
  });

  it("デイリーにミスはない。10 本通して limit", () => {
    const turns = Array.from({ length: 10 }, () =>
      played({ missBelow: null, score: 0, deviation: 30 }),
    );
    expect(summarizeRun("daily", turns)).toMatchObject({ reached: 10, misses: 0, ended: "limit" });
  });

  it("記号列はデイリーだけ。境界は 60 / 50 / 40、skip と校正中は —", () => {
    const d = (deviation: number | null): RecordedTurn => played({ missBelow: null, deviation });
    const s = summarizeRun("daily", [
      d(60),
      d(59.9),
      d(50),
      d(49.9),
      d(40),
      d(39.9),
      d(null),
      played({ missBelow: null, via: "timeout", score: 0, deviation: 20 }),
      d(80),
      d(20),
    ]);
    expect(s.symbols).toBe("◎○○△△×——◎×");
    expect(summarizeRun("endless", [played()]).symbols).toBeNull();
  });

  it("記号列は山札の位置ごとに 1 文字。飛ばした位置は —（mo#A.3）", () => {
    const at = (deckIndex: number, deviation: number): RecordedTurn =>
      played({ missBelow: null, deviation, deckIndex });
    // 位置 3 の投稿が出せなくなり、9 手番で終わった日
    const turns = [0, 1, 2, 4, 5, 6, 7, 8, 9].map((i) => at(i, 55));
    const s = summarizeRun("daily", turns);
    expect(s.symbols).toBe("○○○—○○○○○○");
    expect(s).toMatchObject({ reached: 9, ended: "limit" });
  });

  it("中断したデイリーの記号列は最後に遊んだ位置まで（#136）", () => {
    const at = (deckIndex: number): RecordedTurn =>
      played({ missBelow: null, deviation: 61, deckIndex });
    expect(summarizeRun("daily", [at(0), at(1), at(3)]).symbols).toBe("◎◎—◎");
    expect(summarizeRun("daily", [at(0), at(1), at(3)]).ended).toBe("abandoned");
  });
});
