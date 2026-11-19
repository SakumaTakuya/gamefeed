import { describe, expect, it } from "vitest";
import {
  aliveFrames,
  DAILY_TURN_LIMIT,
  ENDLESS_TURN_LIMIT,
  FINISH_WAIT_MS,
  FIRST_LOAD_WAIT_MS,
  FLASH_MS,
  HIDDEN_ABORT_MS,
  INTERLUDE_MS,
  initialRunHost,
  LOAD_SKIP_LIMIT,
  logState,
  PREFETCH_SLOTS,
  RESULT_RETRY_MAX_MS,
  RESULT_RETRY_MIN_MS,
  type RunHostEffect,
  type RunHostEvent,
  type RunHostState,
  type RunMode,
  runHostStep,
  type TurnOutcome,
  turnAt,
  unsettledTurns,
} from "../src/index.ts";

type Of<T extends RunHostEffect["type"]> = Extract<RunHostEffect, { type: T }>;
type ResultEvent = Extract<RunHostEvent, { type: `result_${string}` }>;

/**
 * ラン画面とサーバの代わり。イベントを 1 つずつ渡し、effects を記録して、毎回 run#A.15 の不変条件を見る。
 * サーバは記録（手番の扱いの列）だけを持ち、run#A.3 の表のとおりに応答する。応答を届けるかはテストが決める。
 */
class Sim {
  state: RunHostState;
  /** 最後のイベントで出た effects */
  out: RunHostEffect[] = [];
  /** これまでの effects すべて */
  all: RunHostEffect[] = [];
  /** サーバの記録 */
  log: TurnOutcome[] = [];
  /** サーバが期限・`finish` で閉じた */
  expired = false;
  /** 送って、まだ応答していない結果 */
  inflight: Of<"send_result"> | null = null;
  startedAfterEnd = false;
  /** 始めた手番（`start` を出した順） */
  started: { turn: number; index: number; lap: number }[] = [];
  readonly mode: RunMode;
  readonly deck: number;

  constructor(
    missBelow: readonly (number | null)[] = Array(12).fill(30),
    mode: RunMode = "endless",
  ) {
    this.mode = mode;
    this.deck = missBelow.length;
    const init = initialRunHost({ mode, missBelow });
    this.state = init.state;
    this.record(init.effects);
    this.check();
  }

  private record(effects: RunHostEffect[]): void {
    this.out = effects;
    this.all.push(...effects);
    for (const e of effects) {
      if (e.type !== "send_result") continue;
      expect(this.inflight, "結果を同時に 2 つ送らない").toBeNull();
      this.inflight = e;
    }
  }

  send(event: RunHostEvent): this {
    const before = this.state;
    const r = runHostStep(before, event);
    expect(r.ok, `${event.type} は ${before.phase} で受理される`).toBe(true);
    if (!r.ok) return this;
    const ended = logState(this.mode, this.deck, before.outcomes).ended !== null;
    for (const e of r.effects) {
      if (e.type !== "start") continue;
      // F5: start は INITED のスロットにだけ。F8: ランが終わった後に start しない
      const slot = before.pending.find((p) => p.iframe === e.iframe);
      expect(slot?.frame, "F5: start は INITED のスロットに").toBe("INITED");
      if (ended || before.lives === 0) this.startedAfterEnd = true;
      // 始める手番は、計画とそれまでの扱いから決まる値（run#A.3）
      const at = turnAt(this.mode, this.deck, before.outcomes);
      expect(at).toMatchObject({ done: false, ...slot?.turn });
      if (slot) this.started.push(slot.turn);
    }
    this.state = r.state;
    this.record(r.effects);
    this.check();
    return this;
  }

  /** F1〜F4 と、先読み・結果の送り方・記録（F10）の不変条件 */
  private check(): void {
    const s = this.state;
    expect(s.pending.length, "F3: 次に出す手番は 2 本まで").toBeLessThanOrEqual(PREFETCH_SLOTS);
    expect(aliveFrames(s), "F4: iframe は 3 枚以下").toBeLessThanOrEqual(3);
    // 生きている iframe: load されて destroy されていないもの
    const alive = new Set<number>();
    for (const e of this.all) {
      if (e.type === "load") alive.add(e.iframe);
      if (e.type === "destroy") {
        expect(alive.has(e.iframe), "destroy は生きている iframe に").toBe(true);
        alive.delete(e.iframe);
      }
    }
    const held = [...(s.current ? [s.current] : []), ...s.pending].map((p) => p.iframe);
    expect(
      [...alive].sort((a, b) => a - b),
      "state と effects の iframe が一致",
    ).toEqual(held.sort((a, b) => a - b));
    // 先読みは計画どおり: まだ決まっていない手番を成立として求めた位置と一致する
    const first = s.outcomes.length + (s.current && s.current.frame !== "ENDED" ? 1 : 0);
    // （ランが終わった後のフラッシュの間は、残った先読みを触らずに置いてある）
    const live = logState(this.mode, this.deck, s.outcomes).ended === null ? s.pending : [];
    live.forEach((p, j) => {
      const assumed = [...s.outcomes, ...Array(first + j - s.outcomes.length).fill("ok")];
      expect(turnAt(this.mode, this.deck, assumed), "先読みが計画どおり").toMatchObject({
        done: false,
        ...p.turn,
      });
    });
    // 送っているのは、記録にまだ無い最も古い手番
    if (this.inflight) {
      expect(s.sending).toBe(this.inflight.turn);
      expect(this.inflight.via).toBe(s.vias[this.inflight.turn]);
    }
    expect(s.settled).toBeLessThanOrEqual(s.outcomes.length);
    // F10: 記録は Host が見たランの先頭部分
    expect(this.log).toEqual(s.outcomes.slice(0, this.log.length));
    if (s.lives !== null) {
      expect(s.lives).toBe(3 - s.outcomes.filter((o) => o === "miss").length);
    }
    expect(s.loadSkips).toBe(s.outcomes.filter((o) => o === "noload").length);
  }

  rejects(event: RunHostEvent, reason: string): void {
    const r = runHostStep(this.state, event);
    expect(r).toMatchObject({ ok: false, reason });
    expect(r.state).toBe(this.state);
  }

  effects<T extends RunHostEffect["type"]>(type: T): Of<T>[] {
    return this.out.filter((e): e is Of<T> => e.type === type);
  }
  every<T extends RunHostEffect["type"]>(type: T): Of<T>[] {
    return this.all.filter((e): e is Of<T> => e.type === type);
  }

  /** サーバが送られた結果を処理する（run#A.3 の表）。応答のイベントを返す。届けるのは呼び出し側 */
  serve(): ResultEvent {
    const sent = this.inflight;
    if (!sent) throw new Error("送っている結果が無い");
    this.inflight = null;
    const { turn } = sent;
    const closed = this.expired || logState(this.mode, this.deck, this.log).ended !== null;
    if (turn < this.log.length) return { type: "result_settled", turn, settled: this.log.length };
    if (closed) return { type: "result_closed", turn, settled: this.log.length };
    if (turn > this.log.length) {
      return { type: "result_out_of_order", turn, settled: this.log.length };
    }
    this.log.push(this.state.outcomes[turn] as TurnOutcome);
    return { type: "result_settled", turn, settled: this.log.length };
  }
  /** 送っている結果にサーバが応答し、届く */
  answer(): this {
    return this.send(this.serve());
  }
  /** 送っている結果がサーバに届かない */
  lose(): this {
    const turn = this.inflight?.turn as number;
    this.inflight = null;
    return this.send({ type: "result_failed", turn });
  }
  /** サーバには届いたが、応答が届かない */
  loseReply(): this {
    const { turn } = this.serve();
    return this.send({ type: "result_failed", turn });
  }
  /** 送っているものが無くなるまで応答する */
  answerAll(): this {
    while (this.inflight && this.state.phase !== "finished") this.answer();
    return this;
  }

  /** その iframe を INITED まで進める */
  load(iframe: number): this {
    return this.send({ type: "ready", iframe }).send({ type: "inited", iframe });
  }
  loadAll(): this {
    for (const p of this.state.pending) {
      if (p.frame === "LOADING") this.send({ type: "ready", iframe: p.iframe });
      if (p.frame !== "INITED") this.send({ type: "inited", iframe: p.iframe });
    }
    return this;
  }
  /** 動いているタイマーを満了させる。名前と長さを確かめる */
  fire(name: string, ms: number): this {
    const id = this.state.timer?.id;
    const t = this.every("timer").find((e) => e.id === id);
    expect(t, `タイマー ${name} が動いている`).toBeDefined();
    expect({ name: t?.name, ms: t?.ms }).toEqual({ name, ms });
    return this.send({ type: "timer", id: id as number });
  }
  end(score: number | "timeout" | "error"): this {
    const iframe = this.state.current?.iframe as number;
    const result =
      typeof score === "number" ? ({ via: "guest", score } as const) : ({ via: score } as const);
    return this.send({ type: "end", iframe, result });
  }
  /**
   * スタートして手番 0 が動くところまで。second が "inited" なら次の 2 手番も INITED、
   * "loading" なら手番 1 は LOADING のまま
   */
  static started(
    missBelow?: readonly (number | null)[],
    second: "inited" | "loading" = "inited",
    mode: RunMode = "endless",
  ): Sim {
    const sim = new Sim(missBelow, mode);
    if (second === "inited") sim.loadAll();
    else sim.load(sim.state.pending[0]?.iframe as number);
    sim.send({ type: "begin" }).fire("interlude", INTERLUDE_MS);
    if (second === "inited") sim.loadAll();
    return sim;
  }
  /** 手番を 1 つ遊んで、次の手番が動くところまで（結果は記録に入る。先読みはすべて INITED にする） */
  playThrough(score: number | "timeout" | "error"): this {
    this.end(score).answerAll().loadAll().fire("flash", FLASH_MS);
    if (this.state.phase === "interlude") this.fire("interlude", INTERLUDE_MS).loadAll();
    return this;
  }
}

describe("定数（run#A.5〜A.7、A.9）", () => {
  it("文書の値", () => {
    expect(FLASH_MS).toBe(500);
    expect(INTERLUDE_MS).toBe(1000);
    expect(FIRST_LOAD_WAIT_MS).toBe(10_000);
    expect(RESULT_RETRY_MIN_MS).toBe(1000);
    expect(RESULT_RETRY_MAX_MS).toBe(8000);
    expect(FINISH_WAIT_MS).toBe(10_000);
    expect(HIDDEN_ABORT_MS).toBe(10 * 60 * 1000);
  });
});

describe("先読みとスタート（run#A.3〜A.5）", () => {
  it("R-8.2-3 始まりは計画の最初の 2 手番を不可視で読み込み、init まで進める。発行は頼まない", () => {
    const sim = new Sim();
    expect(sim.state).toMatchObject({ phase: "idle", lives: 3, settled: 0, ended: null });
    expect(sim.out).toEqual([
      { type: "load", iframe: 1, turn: 0, index: 0, lap: 0, speed: 1 },
      { type: "load", iframe: 2, turn: 1, index: 1, lap: 0, speed: 1 },
      { type: "timer", id: 1, name: "first", ms: FIRST_LOAD_WAIT_MS },
    ]);
    sim.send({ type: "ready", iframe: 1 });
    expect(sim.out).toEqual([{ type: "init", iframe: 1 }]);
    sim.send({ type: "inited", iframe: 1 });
    // 不可視スロットに start は送らない
    expect(sim.every("start")).toEqual([]);
    expect(sim.state.pending[0]).toEqual({
      iframe: 1,
      turn: { turn: 0, index: 0, lap: 0, speed: 1 },
      frame: "INITED",
    });
  });

  it("R-8.2-2 スタートの操作は最初の手番が INITED になってから受け付ける", () => {
    const sim = new Sim();
    sim.rejects({ type: "begin" }, "not_allowed");
    // 手番 1 が先に INITED になっても、最初の手番がまだなら受けない
    sim.load(2);
    sim.rejects({ type: "begin" }, "not_allowed");
    sim.send({ type: "ready", iframe: 1 });
    sim.rejects({ type: "begin" }, "not_allowed");
    sim.send({ type: "inited", iframe: 1 });
    // 間に合ったので、10 秒の待ちは止まる
    expect(sim.state.timer).toBeNull();
    sim.rejects({ type: "timer", id: 1 }, "stale");
    sim.send({ type: "begin" });
    expect(sim.state.phase).toBe("interlude");
  });

  it("R-8.2-3 スタートの操作で幕間を 1 秒出し、終わりに最初の手番へ start。空いたスロットを計画の次の手番で埋める", () => {
    const sim = new Sim();
    sim.loadAll().send({ type: "begin" });
    expect(sim.every("start")).toEqual([]);
    sim.fire("interlude", INTERLUDE_MS);
    expect(sim.out).toEqual([
      { type: "start", iframe: 1 },
      { type: "load", iframe: 3, turn: 2, index: 2, lap: 0, speed: 1 },
    ]);
    expect(sim.state).toMatchObject({
      phase: "running",
      current: { iframe: 1, turn: { turn: 0 }, frame: "RUNNING" },
    });
    expect(sim.state.pending.map((p) => p.turn.turn)).toEqual([1, 2]);
  });

  it("R-8.2-3 手番の切り替え: end → フラッシュ 0.5 秒 → 幕間 1 秒 → 次へ start、前の iframe を destroy、N+2 を作る", () => {
    const sim = Sim.started();
    expect(aliveFrames(sim.state)).toBe(3);
    sim.end(55);
    expect(sim.out).toEqual([
      { type: "send_result", turn: 0, via: "guest", delayMs: 0 },
      { type: "timer", id: 3, name: "flash", ms: FLASH_MS },
    ]);
    expect(sim.state).toMatchObject({ phase: "flash", current: { frame: "ENDED" } });
    sim.fire("flash", FLASH_MS);
    expect(sim.state.phase).toBe("interlude");
    expect(sim.every("start")).toHaveLength(1);
    sim.fire("interlude", INTERLUDE_MS);
    expect(sim.out).toEqual([
      { type: "start", iframe: 2 },
      { type: "destroy", iframe: 1 },
      { type: "load", iframe: 4, turn: 3, index: 3, lap: 0, speed: 1 },
    ]);
    expect(sim.state).toMatchObject({ phase: "running", current: { turn: { turn: 1 } } });
  });

  it("R-run.A3-3 手番の位置・周回・速度は計画から: 山札を回るたびに周回が増えて速くなる", () => {
    const sim = Sim.started([null, null, null]);
    for (let i = 0; i < 7; i++) sim.playThrough(5);
    expect(sim.started.slice(0, 8)).toEqual([
      { turn: 0, index: 0, lap: 0, speed: 1 },
      { turn: 1, index: 1, lap: 0, speed: 1 },
      { turn: 2, index: 2, lap: 0, speed: 1 },
      { turn: 3, index: 0, lap: 1, speed: 1.125 },
      { turn: 4, index: 1, lap: 1, speed: 1.125 },
      { turn: 5, index: 2, lap: 1, speed: 1.125 },
      { turn: 6, index: 0, lap: 2, speed: 1.25 },
      { turn: 7, index: 1, lap: 2, speed: 1.25 },
    ]);
  });

  it("古いタイマー・知らない iframe・phase に合わないイベントは拒否し、状態を変えない", () => {
    const sim = Sim.started();
    sim.rejects({ type: "timer", id: 999 }, "stale");
    sim.rejects({ type: "timer", id: 1 }, "stale");
    sim.rejects({ type: "ready", iframe: 42 }, "stale");
    sim.rejects({ type: "end", iframe: 7, result: { via: "guest", score: 1 } }, "stale");
    sim.rejects({ type: "begin" }, "not_allowed");
    sim.rejects({ type: "result_settled", turn: 0, settled: 1 }, "stale");
    sim.rejects({ type: "show" }, "not_allowed");
    sim.end(55);
    sim.rejects({ type: "end", iframe: 1, result: { via: "guest", score: 55 } }, "not_allowed");
    // 送っていない手番への応答
    sim.rejects({ type: "result_settled", turn: 1, settled: 2 }, "stale");
  });
});

describe("skip（run#A.5 の 6、A.6）", () => {
  it("R-8.2-2 幕間の終わりに次が INITED でなければ、待たずに読み込みの skip: destroy、{via: noload}、残機不変、N+2 を繰り上げて空きを埋める", () => {
    const sim = Sim.started(undefined, "loading");
    // 手番 1（iframe 2）は LOADING のまま、手番 2（iframe 3）は INITED
    sim.load(3).end(55).answerAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.out).toEqual([
      { type: "destroy", iframe: 2 },
      { type: "send_result", turn: 1, via: "noload", delayMs: 0 },
      { type: "load", iframe: 4, turn: 3, index: 3, lap: 0, speed: 1 },
      { type: "timer", id: 5, name: "interlude", ms: INTERLUDE_MS },
    ]);
    expect(sim.every("start")).toHaveLength(1);
    expect(sim.state).toMatchObject({
      phase: "interlude",
      lives: 3,
      loadSkips: 1,
      outcomes: ["ok", "noload"],
    });
    // 繰り上がった手番 2 が先頭。幕間（手順 4）からやり直す
    expect(sim.state.pending.map((p) => p.turn.turn)).toEqual([2, 3]);
    sim.fire("interlude", INTERLUDE_MS);
    expect(sim.effects("start")).toEqual([{ type: "start", iframe: 3 }]);
    expect(sim.state.current?.turn).toMatchObject({ turn: 2, index: 2 });
  });

  it("R-8.2-2 READY（init の途中）でも INITED でなければ読み込みの skip。延長はしない", () => {
    const sim = Sim.started(undefined, "loading");
    sim.send({ type: "ready", iframe: 2 });
    sim.end(55).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.state.outcomes).toEqual(["ok", "noload"]);
    expect(sim.state.timer?.name).toBe("interlude");
    // 捨てた iframe に遅れて届いた init の完了は捨てる
    sim.rejects({ type: "inited", iframe: 2 }, "stale");
  });

  it("R-run.A6-1 読み込みの skip になった位置は、以後の周回に出ない", () => {
    const sim = Sim.started([null, null, null], "loading");
    // 手番 1（位置 1）が読み込みの skip
    sim.load(3).end(5).answerAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.loadAll().fire("interlude", INTERLUDE_MS).loadAll();
    for (let i = 0; i < 4; i++) sim.playThrough(5);
    expect(sim.started.map((t) => `${t.index}@${t.lap}`)).toEqual([
      "0@0",
      "2@0",
      "0@1",
      "2@1",
      "0@2",
      "2@2",
    ]);
  });

  it("R-run.A6-1 満了・error も skip: 残機は減らず、結果は送り、その位置は以後の周回に出ない", () => {
    const sim = Sim.started([30, 30, 30]);
    sim.end("timeout");
    expect(sim.state).toMatchObject({
      lives: 3,
      loadSkips: 0,
      outcomes: ["skip"],
      last: { turn: 0, via: "timeout", score: null, miss: false },
    });
    expect(sim.effects("send_result")).toEqual([
      { type: "send_result", turn: 0, via: "timeout", delayMs: 0 },
    ]);
    sim.answerAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS).loadAll();
    sim.playThrough("error").playThrough(40).playThrough(40);
    expect(sim.state.outcomes).toEqual(["skip", "skip", "ok", "ok"]);
    expect(sim.started.map((t) => `${t.index}@${t.lap}`)).toEqual([
      "0@0",
      "1@0",
      "2@0",
      "2@1",
      "2@2",
    ]);
  });

  it("R-run.A6-1 先読み済みの手番が飛ばす位置に当たったら、捨てて作り直す", () => {
    const sim = Sim.started([30, 30]);
    // 表示中は手番 0（位置 0）。先読みは手番 1（位置 1）と手番 2（位置 0 の 2 周目、iframe 3）
    expect(sim.state.pending.map((p) => p.turn)).toEqual([
      { turn: 1, index: 1, lap: 0, speed: 1 },
      { turn: 2, index: 0, lap: 1, speed: 1.125 },
    ]);
    sim.end("timeout");
    // 位置 0 はもう出ない。手番 2 は位置 1 の 2 周目になる
    expect(sim.out.slice(1, 3)).toEqual([
      { type: "destroy", iframe: 3 },
      { type: "load", iframe: 4, turn: 2, index: 1, lap: 1, speed: 1.125 },
    ]);
    sim.rejects({ type: "ready", iframe: 3 }, "stale");
    expect(sim.state.pending.map((p) => p.frame)).toEqual(["INITED", "LOADING"]);
  });

  it("R-run.A6-1 出せる位置が無くなったら、次の手番が無いので終わる（limit）", () => {
    const sim = Sim.started([30, 30]);
    sim.playThrough("timeout");
    // 残る位置は 1 だけ。先読みは位置 1 の 2 周目と 3 周目
    expect(sim.state.pending.map((p) => `${p.turn.index}@${p.turn.lap}`)).toEqual(["1@1", "1@2"]);
    sim.end("error");
    // 残っていた先読みは、フラッシュの後にまとめて外す
    sim.answerAll().fire("flash", FLASH_MS);
    expect(sim.state).toMatchObject({
      phase: "finished",
      ended: "limit",
      outcomes: ["skip", "skip"],
    });
    expect(aliveFrames(sim.state)).toBe(0);
  });

  it("R-run.A6-1 3 本目の読み込みの skip で、幕間に戻らず通信エラーで終わる。finish は呼ぶ", () => {
    const sim = Sim.started(undefined, "loading");
    sim.end(55).answerAll().fire("flash", FLASH_MS);
    sim.fire("interlude", INTERLUDE_MS).answerAll();
    sim.fire("interlude", INTERLUDE_MS).answerAll();
    expect(sim.state).toMatchObject({ phase: "interlude", loadSkips: 2, ended: null });
    // 3 本目。その間に後ろの先読みが INITED になっていても始めない
    sim.load(sim.state.pending[1]?.iframe as number);
    sim.fire("interlude", INTERLUDE_MS);
    expect(sim.state).toMatchObject({
      phase: "closing",
      ended: "error",
      loadSkips: LOAD_SKIP_LIMIT,
      outcomes: ["ok", "noload", "noload", "noload"],
    });
    expect(aliveFrames(sim.state)).toBe(0);
    expect(sim.every("finish")).toEqual([]);
    sim.answerAll();
    expect(sim.out).toEqual([{ type: "finish" }]);
    expect(sim.every("start")).toHaveLength(1);
    expect(sim.startedAfterEnd).toBe(false);
    // サーバの記録も通信エラーで閉じている
    expect(logState("endless", 12, sim.log).ended).toBe("error");
  });
});

describe("最初の手番（run#A.6、#175）", () => {
  it("R-8.2-2 スタート画面で 10 秒待っても INITED でなければ読み込みの skip にし、次の手番を最初の手番として待つ", () => {
    const sim = new Sim();
    sim.fire("first", FIRST_LOAD_WAIT_MS);
    expect(sim.out).toEqual([
      { type: "destroy", iframe: 1 },
      { type: "send_result", turn: 0, via: "noload", delayMs: 0 },
      { type: "load", iframe: 3, turn: 2, index: 2, lap: 0, speed: 1 },
      { type: "timer", id: 2, name: "first", ms: FIRST_LOAD_WAIT_MS },
    ]);
    expect(sim.state).toMatchObject({ phase: "idle", loadSkips: 1, outcomes: ["noload"] });
    sim.rejects({ type: "begin" }, "not_allowed");
    // 手番 1 が INITED になればスタートできる。最初の start は手番 1
    sim.load(2);
    expect(sim.state.timer).toBeNull();
    sim.send({ type: "begin" }).fire("interlude", INTERLUDE_MS);
    expect(sim.effects("start")).toEqual([{ type: "start", iframe: 2 }]);
    expect(sim.state.current?.turn).toMatchObject({ turn: 1, index: 1 });
  });

  it("R-8.2-2 繰り上がった手番がもう INITED なら、待たずにスタートを受け付ける", () => {
    const sim = new Sim();
    sim.load(2).fire("first", FIRST_LOAD_WAIT_MS);
    expect(sim.state.timer).toBeNull();
    expect(sim.effects("timer")).toEqual([]);
    sim.send({ type: "begin" });
  });

  it("R-run.A15-1 最初の手番が 3 本続けて読めなければ通信エラー（スタート画面で待つのは最長 30 秒。F6）", () => {
    const sim = new Sim();
    sim.fire("first", FIRST_LOAD_WAIT_MS).fire("first", FIRST_LOAD_WAIT_MS);
    expect(sim.state).toMatchObject({ phase: "idle", loadSkips: 2 });
    sim.fire("first", FIRST_LOAD_WAIT_MS);
    expect(sim.state).toMatchObject({ phase: "closing", ended: "error" });
    expect(sim.every("timer").filter((t) => t.name === "first")).toHaveLength(3);
    expect(sim.every("start")).toEqual([]);
    expect(aliveFrames(sim.state)).toBe(0);
    sim.answerAll();
    expect(sim.state.phase).toBe("finished");
    expect(sim.log).toEqual(["noload", "noload", "noload"]);
  });

  it("非表示の間はスタート画面の待ちで読み込みの skip を決めず、表示に戻ったら 10 秒を計り直す", () => {
    const sim = new Sim();
    sim.send({ type: "hide" }).fire("first", FIRST_LOAD_WAIT_MS);
    expect(sim.state).toMatchObject({ phase: "idle", loadSkips: 0, timer: null });
    sim.send({ type: "show" });
    expect(sim.effects("timer")).toMatchObject([{ name: "first", ms: FIRST_LOAD_WAIT_MS }]);
  });
});

describe("残機とミス（run#A.7）", () => {
  it("R-run.A7-1 ミスは end の瞬間に、計画のその位置の miss_below で決まり、通信を待たずに残機が減る", () => {
    const sim = Sim.started([30, 50, 30]);
    sim.end(29);
    expect(sim.state).toMatchObject({ lives: 2, last: { turn: 0, score: 29, miss: true } });
    expect(sim.state.sending).toBe(0);
    // 手番 1 は位置 1 の閾値（50）で判定する
    sim.fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS).end(49);
    expect(sim.state).toMatchObject({ lives: 1, outcomes: ["miss", "miss"] });
  });

  it("R-run.A7-1 閾値ちょうど・miss_below: null（新作枠、校正中）はミスにならない（F7）。デイリーに残機は無い", () => {
    const at = Sim.started([30]);
    at.end(30);
    expect(at.state).toMatchObject({ lives: 3, last: { miss: false } });
    const fresh = Sim.started([null]);
    fresh.end(0);
    expect(fresh.state).toMatchObject({ lives: 3, last: { miss: false } });
    const daily = Sim.started([null, null], "inited", "daily");
    daily.end(0);
    expect(daily.state).toMatchObject({ lives: null, outcomes: ["ok"] });
  });

  it("R-run.A7-1 3 回目のミスでランが終わり、幕間に進まず start は出ない（F8）。iframe はフラッシュの後にすべて外す", () => {
    const sim = Sim.started();
    sim.playThrough(0).playThrough(0);
    expect(sim.state).toMatchObject({ phase: "running", lives: 1 });
    const starts = sim.every("start").length;
    const pending = sim.state.pending.map((p) => p.iframe);
    sim.end(0);
    expect(sim.state).toMatchObject({ phase: "flash", lives: 0 });
    // フラッシュの間は先読みを触らない
    expect(sim.effects("destroy")).toEqual([]);
    expect(sim.effects("load")).toEqual([]);
    sim.fire("flash", FLASH_MS);
    expect(sim.state).toMatchObject({ phase: "closing", ended: "lives" });
    expect(sim.effects("destroy").map((e) => e.iframe)).toEqual([3, ...pending]);
    expect(aliveFrames(sim.state)).toBe(0);
    expect(sim.every("start")).toHaveLength(starts);
    expect(sim.startedAfterEnd).toBe(false);
    // 終わった後に届いた ready は捨てる
    sim.rejects({ type: "ready", iframe: pending[0] as number }, "stale");
  });

  it("R-run.A7-1 結果の応答が来なくても進行は変わらない（F11）", () => {
    const sim = Sim.started([null, null, null]);
    for (let i = 0; i < 5; i++) {
      sim.end(5).loadAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    }
    expect(sim.state).toMatchObject({
      phase: "running",
      current: { turn: { turn: 5 } },
      settled: 0,
      sending: 0,
    });
    expect(sim.every("send_result")).toHaveLength(1);
  });

  it("上限の手番が終わったらランは終わる。上限より先の手番は作らない", () => {
    // デイリーは山札 10 本で上限 10 手番。1 周で終わる
    const sim = Sim.started(Array(DAILY_TURN_LIMIT).fill(null), "inited", "daily");
    for (let i = 0; i < DAILY_TURN_LIMIT - 1; i++) sim.playThrough(5);
    expect(sim.state.current?.turn).toEqual({ turn: 9, index: 9, lap: 0, speed: 1 });
    expect(sim.state.pending).toEqual([]);
    sim.end(5).answerAll().fire("flash", FLASH_MS);
    expect(sim.state).toMatchObject({ phase: "finished", ended: "limit" });
    expect(sim.every("load")).toHaveLength(DAILY_TURN_LIMIT);
  });
});

describe("結果の送り方と finish（run#A.7）", () => {
  it("R-run.A7-2 結果は手番の順に 1 つずつ送る。応答が来たら次を送る", () => {
    const sim = Sim.started([null, null, null]);
    sim.end(5).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS).end("timeout");
    // 手番 0 の応答がまだなので、手番 1 は送らない
    expect(sim.every("send_result").map((e) => e.turn)).toEqual([0]);
    sim.answer();
    expect(sim.out).toEqual([{ type: "send_result", turn: 1, via: "timeout", delayMs: 0 }]);
    sim.answer();
    expect(sim.out).toEqual([]);
    expect(sim.state).toMatchObject({ settled: 2, sending: null });
    expect(unsettledTurns(sim.state)).toBe(0);
  });

  it("R-run.A7-2 応答が来なければ同じ手番を送り直す。間隔は 1 秒から倍にして最大 8 秒。記録に入ったら 1 秒に戻る", () => {
    const sim = Sim.started([null, null, null]);
    sim.end(5);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      sim.lose();
      expect(sim.out).toMatchObject([{ type: "send_result", turn: 0, via: "guest" }]);
      delays.push(sim.effects("send_result")[0]?.delayMs as number);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    sim.answer().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS).end(5).lose();
    expect(sim.effects("send_result")).toEqual([
      { type: "send_result", turn: 1, via: "guest", delayMs: 1000 },
    ]);
  });

  it("R-run.A7-2 サーバには届いて応答だけが消えても、送り直しで同じ手番が二重に入らない", () => {
    const sim = Sim.started([null, null, null]);
    sim.end(5).loseReply();
    expect(sim.log).toEqual(["ok"]);
    expect(sim.state.settled).toBe(0);
    sim.answer();
    expect(sim.log).toEqual(["ok"]);
    expect(sim.state.settled).toBe(1);
  });

  it("R-run.A7-2 out_of_order が返ったら、応答の settled の手番から送り直す", () => {
    const sim = Sim.started([null, null, null]);
    sim.playThrough(5).playThrough(5).end(5);
    expect(sim.state).toMatchObject({ settled: 2, sending: 2 });
    sim.inflight = null;
    sim.log.length = 1; // 検査のため、サーバの記録が手元の値より短い状況を作る
    sim.send({ type: "result_out_of_order", turn: 2, settled: 1 });
    expect(sim.out).toEqual([{ type: "send_result", turn: 1, via: "guest", delayMs: 1000 }]);
    sim.answer();
    expect(sim.out).toEqual([{ type: "send_result", turn: 2, via: "guest", delayMs: 0 }]);
    sim.answer();
    expect(sim.log).toEqual(["ok", "ok", "ok"]);
  });

  it("R-run.A7-2 ランが終わっても、遊んだ手番がすべて記録に入るまで finish を呼ばない", () => {
    const sim = Sim.started();
    sim.playThrough(0).playThrough(0);
    sim.end(0).fire("flash", FLASH_MS);
    expect(sim.state).toMatchObject({ phase: "closing", settled: 2 });
    const wait = sim.state.timer?.id as number;
    expect(sim.out.at(-1)).toEqual({ type: "timer", id: wait, name: "finish", ms: FINISH_WAIT_MS });
    expect(sim.every("finish")).toEqual([]);
    sim.lose();
    expect(sim.every("finish")).toEqual([]);
    sim.answer();
    expect(sim.out).toEqual([{ type: "finish" }]);
    expect(sim.state).toMatchObject({ phase: "finished", timer: null });
    sim.rejects({ type: "abort" }, "not_allowed");
    sim.rejects({ type: "timer", id: wait }, "stale");
  });

  it("R-run.A7-2 10 秒待っても記録に入らなければ、そのまま finish を呼ぶ。入らなかった本数が分かる", () => {
    const sim = Sim.started();
    sim.end(0).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.end(0).loadAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.end(0).fire("flash", FLASH_MS);
    expect(sim.state).toMatchObject({ phase: "closing", ended: "lives", settled: 0 });
    sim.lose().fire("finish", FINISH_WAIT_MS);
    expect(sim.out).toEqual([{ type: "finish" }]);
    expect(unsettledTurns(sim.state)).toBe(3);
    // finish の後に届いた応答は捨てる
    sim.rejects({ type: "result_settled", turn: 0, settled: 1 }, "stale");
  });

  it("R-run.A15-2 サーバが記録を閉じても（run_closed）Host の進行は変わらない（F11）。もう送らず、終わったらすぐ finish", () => {
    const sim = Sim.started([null, null, null]);
    sim.playThrough(5);
    sim.expired = true;
    sim.end(5).answer();
    expect(sim.state).toMatchObject({ serverClosed: true, settled: 1, phase: "flash" });
    sim.loadAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.state.phase).toBe("running");
    sim.end(5);
    expect(sim.effects("send_result")).toEqual([]);
    sim.send({ type: "abort" });
    expect(sim.out.at(-1)).toEqual({ type: "finish" });
    expect(sim.log).toEqual(["ok"]);
    expect(unsettledTurns(sim.state)).toBe(2);
  });
});

describe("ランの終わり（run#A.15 F6）", () => {
  it("R-run.A15-1 先読みが 1 つも間に合わなくても、読み込みの skip 3 本で終わる", () => {
    const sim = new Sim();
    let steps = 0;
    while (sim.state.phase !== "finished") {
      expect(++steps, "終わらない").toBeLessThan(50);
      const name = sim.state.timer?.name;
      if (name === "first") sim.fire("first", FIRST_LOAD_WAIT_MS);
      else if (name === "finish") sim.answerAll();
      else throw new Error(`止まった: ${sim.state.phase}`);
    }
    expect(sim.state).toMatchObject({ ended: "error", loadSkips: 3, lives: 3 });
    expect(sim.every("start")).toEqual([]);
  });

  it("R-run.A15-1 満了が続いても終わる: 山札 12 本がすべて満了なら 12 手番で出せる位置が無くなる", () => {
    const sim = Sim.started();
    while (sim.state.phase !== "finished") sim.playThrough("timeout");
    expect(sim.state).toMatchObject({ ended: "limit", lives: 3 });
    expect(sim.state.outcomes).toEqual(Array(12).fill("skip"));
    expect(sim.log).toEqual(sim.state.outcomes);
  });

  it("R-run.A15-1 ミスも skip も無ければ上限の 50 手番で終わる。5 周目は速度 1.5", () => {
    const sim = Sim.started(Array(12).fill(null));
    while (sim.state.phase !== "finished") sim.playThrough(1);
    expect(sim.state.ended).toBe("limit");
    expect(sim.started).toHaveLength(ENDLESS_TURN_LIMIT);
    expect(sim.started.at(-1)).toEqual({ turn: 49, index: 1, lap: 4, speed: 1.5 });
    expect(sim.every("load")).toHaveLength(ENDLESS_TURN_LIMIT);
  });

  it("どんな順でイベントが来ても不変条件（F1〜F5、F8、F10）を保ち、ランは終わる。あきらめなければ記録は見たものと一致する（F12）", () => {
    const seen = new Set<string>();
    // seed から決まる乱数で、ラン画面・回線・サーバのふるまいを揺らす
    for (let seed = 1; seed <= 600; seed++) {
      let a = seed;
      const rand = () => {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        return a / 0x7fffffff;
      };
      const deck = 1 + Math.floor(rand() * 5);
      const mode: RunMode = seed % 5 === 0 ? "daily" : "endless";
      const sim = new Sim(
        Array.from({ length: deck }, (_, i) => (i % 3 === 0 ? null : 30)),
        mode,
      );
      const loss = rand() * 0.6;
      const slowLoad = rand() < 0.3;
      let steps = 0;
      while (sim.state.phase !== "finished") {
        expect(++steps, `seed ${seed} が終わらない`).toBeLessThan(3000);
        const s = sim.state;
        const options: (() => void)[] = [];
        for (const p of s.pending) {
          if (slowLoad && rand() < 0.7) continue;
          if (p.frame === "LOADING")
            options.push(() => sim.send({ type: "ready", iframe: p.iframe }));
          if (p.frame === "READY")
            options.push(() => sim.send({ type: "inited", iframe: p.iframe }));
        }
        if (s.timer) {
          const id = s.timer.id;
          options.push(() => sim.send({ type: "timer", id }));
        }
        if (s.phase === "idle" && s.pending[0]?.frame === "INITED") {
          options.push(() => sim.send({ type: "begin" }));
        }
        if (
          s.current &&
          s.current.frame !== "ENDED" &&
          (s.phase === "running" || s.phase === "resuming")
        ) {
          const r = rand();
          options.push(() =>
            sim.end(r < 0.15 ? "timeout" : r < 0.25 ? "error" : Math.floor(rand() * 60)),
          );
        }
        if (sim.inflight) {
          options.push(() => {
            const r = rand();
            if (r < loss / 2) sim.lose();
            else if (r < loss) sim.loseReply();
            else sim.answer();
          });
        }
        if (s.phase !== "closing") {
          options.push(() => sim.send({ type: s.hidden ? "show" : "hide" }));
        }
        if (s.phase !== "closing" && rand() < 0.01) {
          options.push(() => sim.send({ type: "abort" }));
        }
        if (rand() < 0.002) sim.expired = true;
        expect(options.length, `seed ${seed} が ${s.phase} で止まった`).toBeGreaterThan(0);
        options[Math.floor(rand() * options.length)]?.();
      }
      const s = sim.state;
      expect(sim.startedAfterEnd).toBe(false);
      expect(sim.every("finish")).toHaveLength(1);
      expect(aliveFrames(s)).toBe(0);
      expect(s.ended).not.toBeNull();
      seen.add(s.ended as string);
      // 始めた手番は手番番号の昇順で、skip になった位置は二度と始めない
      expect(sim.started.map((t) => t.turn)).toEqual(
        [...sim.started.map((t) => t.turn)].sort((x, y) => x - y),
      );
      // F12: 遊んだ手番がすべて記録に入っていれば、記録は Host が見たランそのもので、終わった理由も同じ
      if (unsettledTurns(s) === 0 && !s.serverClosed) {
        expect(sim.log).toEqual(s.outcomes);
        expect(logState(mode, deck, sim.log).ended ?? "abandoned").toBe(s.ended);
      }
    }
    expect([...seen].sort()).toEqual(["abandoned", "error", "limit", "lives"]);
  });
});

describe("中断と再開（run#A.9）", () => {
  it("非表示で pause、表示に戻ったら「続きから」の幕間 1 秒の後に resume", () => {
    const sim = Sim.started();
    sim.send({ type: "hide" });
    expect(sim.out).toEqual([{ type: "pause", iframe: 1 }]);
    expect(sim.state).toMatchObject({
      phase: "running",
      hidden: true,
      current: { frame: "PAUSED" },
    });
    sim.send({ type: "show" });
    expect(sim.state.phase).toBe("resuming");
    expect(sim.every("resume")).toEqual([]);
    sim.fire("resume", INTERLUDE_MS);
    expect(sim.out).toEqual([{ type: "resume", iframe: 1 }]);
    expect(sim.state).toMatchObject({ phase: "running", current: { frame: "RUNNING" } });
  });

  it("「続きから」の幕間の途中でまた非表示になったら、resume せずに待つ", () => {
    const sim = Sim.started();
    sim.send({ type: "hide" }).send({ type: "show" });
    const stale = sim.state.timer?.id as number;
    sim.send({ type: "hide" });
    expect(sim.out).toEqual([]);
    sim.rejects({ type: "timer", id: stale }, "stale");
    sim.send({ type: "show" }).fire("resume", INTERLUDE_MS);
    expect(sim.every("resume")).toHaveLength(1);
  });

  it("非表示の間に幕間が終わっても start せず、読み込みの skip も決めない。表示に戻ってから幕間を出し直す", () => {
    const sim = Sim.started(undefined, "loading");
    sim.end(55).send({ type: "hide" });
    sim.fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.every("start")).toHaveLength(1);
    expect(sim.state).toMatchObject({ phase: "interlude", timer: null, loadSkips: 0 });
    // 非表示の間に読み込みが済んだ
    sim.load(2).send({ type: "show" }).fire("interlude", INTERLUDE_MS);
    expect(sim.effects("start")).toEqual([{ type: "start", iframe: 2 }]);
  });

  it("非表示の間でも、ランが終わっていればフラッシュの後に終える", () => {
    const sim = Sim.started();
    sim.playThrough(0).playThrough(0);
    sim.end(0).answerAll().send({ type: "hide" }).fire("flash", FLASH_MS);
    expect(sim.state).toMatchObject({ phase: "finished", ended: "lives" });
  });

  it("中断（abort）: iframe をすべて外し、表示中の手番は結果を送らずに捨て、記録に入るのを待って finish", () => {
    const sim = Sim.started();
    sim.end(55).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.send({ type: "hide" }).send({ type: "abort" });
    expect(sim.out.map((e) => e.type)).toEqual(["destroy", "destroy", "destroy", "timer"]);
    expect(sim.state).toMatchObject({ phase: "closing", ended: "abandoned", outcomes: ["ok"] });
    sim.answer();
    expect(sim.out).toEqual([{ type: "finish" }]);
    expect(sim.every("send_result").map((e) => e.turn)).toEqual([0]);
  });

  it("スタートの前の中断も finish まで進む", () => {
    const sim = new Sim();
    sim.send({ type: "abort" });
    expect(sim.out).toEqual([
      { type: "destroy", iframe: 1 },
      { type: "destroy", iframe: 2 },
      { type: "finish" },
    ]);
    expect(sim.state).toMatchObject({ phase: "finished", ended: "abandoned" });
  });
});
