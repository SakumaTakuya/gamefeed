import { describe, expect, it } from "vitest";
import {
  DAILY_TURN_LIMIT,
  ENDLESS_TURN_LIMIT,
  LOAD_SKIP_LIMIT,
  type LoggedTurn,
  logState,
  outcomeOf,
  summarizeLog,
  type TurnOutcome,
  turnAt,
  turnSeed,
} from "../src/index.ts";

/** 手番の扱いの列を 1 文字ずつで書く: o = 成立、m = ミス、s = skip、n = 読み込みの skip */
const outcomes = (s: string): TurnOutcome[] =>
  [...s].map((c) => (({ o: "ok", m: "miss", s: "skip", n: "noload" }) as const)[c as "o"]);
const log = (s: string, deviation = 55): LoggedTurn[] =>
  outcomes(s).map((outcome) => ({
    outcome,
    deviation: outcome === "ok" ? deviation : outcome === "miss" ? 35 : null,
  }));
/** 手番 0 から順に求めた山札の位置（出せなくなったら null） */
const positions = (deck: number, history: string, mode: "endless" | "daily" = "endless") =>
  Array.from({ length: history.length + 1 }, (_, t) => {
    const at = turnAt(mode, deck, outcomes(history.slice(0, t)));
    return at.done ? null : at.index;
  });

describe("turnAt: 手番の位置・周回・速度（run#A.3、A.8。R-run.A3-3）", () => {
  it("手番 0 は位置 0、周回 0、等速", () => {
    expect(turnAt("endless", 12, [])).toEqual({ done: false, turn: 0, index: 0, lap: 0, speed: 1 });
  });

  it("山札 12 本で、末尾を越えるたびに周回が 1 増え、速度が 1/8 ずつ上がる", () => {
    const history = outcomes("o".repeat(49));
    const at = (t: number) => turnAt("endless", 12, history.slice(0, t));
    expect(at(11)).toMatchObject({ index: 11, lap: 0, speed: 1 });
    expect(at(12)).toMatchObject({ index: 0, lap: 1, speed: 1.125 });
    expect(at(36)).toMatchObject({ index: 0, lap: 3, speed: 1.375 });
    expect(at(48)).toMatchObject({ index: 0, lap: 4, speed: 1.5 });
    expect(at(49)).toMatchObject({ turn: 49, index: 1, lap: 4, speed: 1.5 });
  });

  it("上限の手番より先は無い", () => {
    expect(turnAt("endless", 12, outcomes("o".repeat(ENDLESS_TURN_LIMIT)))).toEqual({
      done: true,
      reason: "limit",
    });
    expect(turnAt("daily", 10, outcomes("o".repeat(DAILY_TURN_LIMIT)))).toEqual({
      done: true,
      reason: "limit",
    });
  });

  it("読み込みの skip になった位置は、以後の周回で飛ばす（run#A.6）", () => {
    // 山札 4 本。手番 1（位置 1）が読み込みの skip。2 周目は 0, 2, 3
    expect(positions(4, "onooooo")).toEqual([0, 1, 2, 3, 0, 2, 3, 0]);
  });

  it("飛ばしても周回は山札の末尾を越えた回数で数える", () => {
    const history = outcomes("onooooo");
    expect(turnAt("endless", 4, history.slice(0, 4))).toMatchObject({ index: 0, lap: 1 });
    expect(turnAt("endless", 4, history.slice(0, 6))).toMatchObject({ index: 3, lap: 1 });
    expect(turnAt("endless", 4, history)).toMatchObject({ index: 0, lap: 2, speed: 1.25 });
  });

  it("末尾の位置が読み込みの skip でも、次の手番は先頭に戻る", () => {
    expect(positions(3, "oonoo")).toEqual([0, 1, 2, 0, 1, 0]);
  });

  it("監視タイマー満了・error の skip とミスは位置を飛ばさない", () => {
    expect(positions(3, "smoso")).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it("直前の手番が読み込みの skip でも、その次の手番の位置は変わらない（先読みが無駄にならない）", () => {
    expect(turnAt("endless", 12, outcomes("oo"))).toMatchObject({ index: 2 });
    expect(turnAt("endless", 12, outcomes("on"))).toMatchObject({ index: 2 });
  });

  it("出せる位置が無くなったら done", () => {
    expect(turnAt("endless", 1, outcomes("n"))).toEqual({ done: true, reason: "no_position" });
    expect(turnAt("endless", 2, outcomes("nn"))).toEqual({ done: true, reason: "no_position" });
    expect(positions(2, "non")).toEqual([0, 1, 1, null]);
  });

  it("デイリーは 1 周で、手番 = 山札の位置、等速", () => {
    expect(positions(10, "onosomoooo", "daily")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
    expect(turnAt("daily", 10, outcomes("ooooo"))).toMatchObject({ index: 5, lap: 0, speed: 1 });
  });

  it("空の山札は例外", () => {
    expect(() => turnAt("endless", 0, [])).toThrow(RangeError);
  });
});

describe("turnSeed: 手番の seed（run#A.3。R-run.A3-3）", () => {
  it("32 bit 符号なし整数で、ランの seed と手番番号から決まる", () => {
    for (const s of [0, 1, 0xdeadbeef, 0xffffffff]) {
      for (const t of [0, 1, 49]) {
        const seed = turnSeed(s, t);
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThanOrEqual(0xffffffff);
        expect(turnSeed(s, t)).toBe(seed);
      }
    }
  });

  it("参照値（式を変えると過去のリプレイが崩れる）", () => {
    // x = (S + t × 0x9E3779B9) mod 2^32 を mulberry32 の混合 1 回に通した値
    expect(turnSeed(0, 0)).toBe(1144304738);
    expect(turnSeed(12345, 7)).toBe(4163666179);
    expect(turnSeed(0xffffffff, 49)).toBe(679217849);
  });

  it("手番が違えば seed も違う（50 手番ぶん）", () => {
    const seeds = new Set(Array.from({ length: 50 }, (_, t) => turnSeed(2026, t)));
    expect(seeds.size).toBe(50);
  });
});

describe("outcomeOf: 結果の扱い（run#A.6、A.7）", () => {
  it("読み込みの skip、監視タイマー満了・error、ミス、成立", () => {
    expect(outcomeOf({ skipped: true })).toBe("noload");
    expect(outcomeOf({ via: "timeout", score: 0, missBelow: 10 })).toBe("skip");
    expect(outcomeOf({ via: "error", score: 0, missBelow: 10 })).toBe("skip");
    expect(outcomeOf({ via: "guest", score: 9, missBelow: 10 })).toBe("miss");
    expect(outcomeOf({ via: "guest", score: 10, missBelow: 10 })).toBe("ok");
    expect(outcomeOf({ via: "guest", score: 0, missBelow: null })).toBe("ok");
  });

  it("デイリーにミスは無い", () => {
    expect(outcomeOf({ via: "guest", score: 0, missBelow: null })).toBe("ok");
  });
});

describe("logState: 記録からランが閉じたかを決める（run#A.3。R-run.A7-2、R-run.A6-1）", () => {
  it("空の記録は開いている", () => {
    expect(logState("endless", 12, [])).toEqual({ ended: null, misses: 0, loadSkips: 0 });
  });

  it("3 回目のミスで lives", () => {
    expect(logState("endless", 12, outcomes("momom"))).toMatchObject({ ended: "lives", misses: 3 });
    expect(logState("endless", 12, outcomes("momo")).ended).toBeNull();
  });

  it("読み込みの skip 3 本で error（デイリーも）", () => {
    expect(LOAD_SKIP_LIMIT).toBe(3);
    expect(logState("endless", 12, outcomes("nonon"))).toMatchObject({ ended: "error", loadSkips: 3 });
    expect(logState("endless", 12, outcomes("nono")).ended).toBeNull();
    expect(logState("daily", 10, outcomes("nnn")).ended).toBe("error");
  });

  it("出せる位置が無くなったら error", () => {
    expect(logState("endless", 2, outcomes("nn")).ended).toBe("error");
    expect(logState("endless", 1, outcomes("n")).ended).toBe("error");
  });

  it("上限で limit。監視タイマー満了の skip が続いても上限で終わる（F6）", () => {
    expect(logState("endless", 12, outcomes("s".repeat(49))).ended).toBeNull();
    expect(logState("endless", 12, outcomes("s".repeat(50))).ended).toBe("limit");
    expect(logState("daily", 10, outcomes("o".repeat(10))).ended).toBe("limit");
  });

  it("上限の手番が 3 回目のミスなら lives、3 本目の読み込みの skip なら error", () => {
    expect(logState("endless", 12, outcomes(`mm${"o".repeat(47)}m`)).ended).toBe("lives");
    expect(logState("endless", 12, outcomes(`nn${"o".repeat(47)}n`)).ended).toBe("error");
  });

  it("デイリーではミスの数で閉じない", () => {
    expect(logState("daily", 10, outcomes("mmmm")).ended).toBeNull();
  });
});

describe("summarizeLog: 成績表の凍結値（sc#A.9。R-sc.A9-1）", () => {
  it("到達手番数は記録の長さ（skip を含む）", () => {
    const s = summarizeLog("endless", 12, log("osnmo"));
    expect(s.reached).toBe(5);
    expect(s.misses).toBe(1);
    expect(s.ended).toBe("abandoned");
  });

  it("終わった理由は記録から決まる", () => {
    expect(summarizeLog("endless", 12, log("mmm")).ended).toBe("lives");
    expect(summarizeLog("endless", 12, log("nnn")).ended).toBe("error");
    expect(summarizeLog("endless", 12, log("o".repeat(50))).ended).toBe("limit");
    expect(summarizeLog("endless", 12, []).ended).toBe("abandoned");
  });

  it("平均偏差値は偏差値のある手番だけ。0.1 単位で足して丸める", () => {
    const turns: LoggedTurn[] = [
      { outcome: "ok", deviation: 20.1 },
      { outcome: "ok", deviation: 64.6 },
      { outcome: "ok", deviation: null },
      { outcome: "skip", deviation: null },
    ];
    expect(summarizeLog("endless", 12, turns).avgDeviation).toBe(42.4);
    expect(summarizeLog("endless", 12, log("sn")).avgDeviation).toBeNull();
  });

  it("エンドレスに記号列は無い", () => {
    expect(summarizeLog("endless", 12, log("oo")).symbols).toBeNull();
  });

  it("デイリーの記号列は 1 手番 1 文字。skip と偏差値のない手番は —、中断なら記録にある位置まで", () => {
    const turns: LoggedTurn[] = [
      { outcome: "ok", deviation: 60 },
      { outcome: "ok", deviation: 59.9 },
      { outcome: "ok", deviation: 40 },
      { outcome: "ok", deviation: 39.9 },
      { outcome: "noload", deviation: null },
      { outcome: "ok", deviation: null },
    ];
    expect(summarizeLog("daily", 10, turns).symbols).toBe("◎○△×——");
    expect(summarizeLog("daily", 10, log("o".repeat(10), 50)).symbols).toBe("○".repeat(10));
  });
});
