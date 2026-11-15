import { describe, expect, it } from "vitest";
import {
  aliveFrames,
  ENDLESS_TURN_LIMIT,
  FLASH_MS,
  HIDDEN_ABORT_MS,
  type HostTurn,
  INTERLUDE_EXTENSION_MS,
  INTERLUDE_MS,
  initialRunHost,
  PREFETCH_SLOTS,
  RESULT_RETRIES,
  RESULT_RETRY_MS,
  type RunHostEffect,
  type RunHostEvent,
  type RunHostState,
  runHostStep,
} from "../src/index.ts";

type Of<T extends RunHostEffect["type"]> = Extract<RunHostEffect, { type: T }>;

/**
 * ラン画面とサーバの代わり。イベントを 1 つずつ渡し、effects を記録して、毎回 run#A.15 の不変条件を見る。
 * 発行（`next`）は頼まれた回数を数えるだけで、応答はテストが `issue()` / `serverDone()` で返す。
 */
class Sim {
  state: RunHostState;
  /** 最後のイベントで出た effects */
  out: RunHostEffect[] = [];
  /** これまでの effects すべて */
  all: RunHostEffect[] = [];
  /** 応答していない `next` の数 */
  requested = 0;
  issued = 0;
  startedAfterZero = false;

  constructor(private missBelow: (turn: number) => number | null = () => 30) {
    const init = initialRunHost();
    this.state = init.state;
    this.record(init.effects);
  }

  private record(effects: RunHostEffect[]): void {
    this.out = effects;
    this.all.push(...effects);
    this.requested += effects.filter((e) => e.type === "request_next").length;
  }

  send(event: RunHostEvent): this {
    const before = this.state;
    const r = runHostStep(before, event);
    expect(r.ok, `${event.type} は ${before.phase} で受理される`).toBe(true);
    if (!r.ok) return this;
    for (const e of r.effects) {
      if (e.type !== "start") continue;
      // F5: start は INITED のスロットにだけ。F8: 残機 0 の後に start しない
      const slot = before.pending.find((p) => p.turn.turn === e.turn);
      const inited = event.type === "inited" && event.turn === e.turn && slot?.frame === "READY";
      expect(slot?.frame === "INITED" || inited, "F5: start は INITED のスロットに").toBe(true);
      if (before.lives === 0) this.startedAfterZero = true;
    }
    this.state = r.state;
    this.record(r.effects);
    this.check();
    return this;
  }

  /** F1〜F4: RUNNING は高々 1 つで N、待ちは 2 本まで、iframe は 3 枚以下 */
  private check(): void {
    const s = this.state;
    expect(s.pending.length, "F3: 次に出す手番は 2 本まで").toBeLessThanOrEqual(PREFETCH_SLOTS);
    expect(aliveFrames(s), "F4: iframe は 3 枚以下").toBeLessThanOrEqual(3);
    expect(s.pending.length + s.requesting, "発行の頼みすぎ").toBeLessThanOrEqual(PREFETCH_SLOTS);
    // 生きている iframe: load されて destroy されていない手番
    const alive = new Set<number>();
    for (const e of this.all) {
      if (e.type === "load") alive.add(e.turn);
      if (e.type === "destroy") alive.delete(e.turn);
    }
    const held = [...(s.current ? [s.current] : []), ...s.pending].map((p) => p.turn.turn);
    expect(
      [...alive].sort((a, b) => a - b),
      "state と effects の iframe が一致",
    ).toEqual(held.sort((a, b) => a - b));
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

  /** `next` の応答: 手番を 1 つ返す */
  issue(): HostTurn {
    expect(this.requested, "頼まれていない発行").toBeGreaterThan(0);
    this.requested--;
    const turn = this.issued++;
    const t = { turn, sessionId: `s${turn}`, missBelow: this.missBelow(turn) };
    this.send({ type: "turn_issued", turn: t });
    return t;
  }
  /** 頼まれているぶんをすべて発行する */
  issueAll(): this {
    while (this.requested > 0) this.issue();
    return this;
  }
  serverDone(): this {
    this.requested--;
    return this.send({ type: "turn_done" });
  }
  /** その手番を INITED まで進める */
  load(turn: number): this {
    return this.send({ type: "ready", turn }).send({ type: "inited", turn });
  }
  loadAll(): this {
    for (const p of this.state.pending) if (p.frame === "LOADING") this.load(p.turn.turn);
    return this;
  }
  /** 動いているタイマーを満了させる。名前と長さを確かめる */
  fire(name: string, ms: number): this {
    const t = this.every("timer").at(-1);
    expect(t, "タイマーが動いている").toBeDefined();
    expect({ id: t?.id, name: t?.name, ms: t?.ms }).toEqual({ id: this.state.timer?.id, name, ms });
    return this.send({ type: "timer", id: t?.id as number });
  }
  end(score: number, via: "guest" | "timeout" | "error" = "guest"): this {
    return this.send({ type: "end", turn: this.state.current?.turn.turn as number, via, score });
  }
  settleAll(): this {
    for (const id of Object.keys(this.state.results)) {
      this.send({ type: "result_settled", sessionId: id });
    }
    return this;
  }
  /**
   * スタートして手番 0 が動くところまで。手番 1 は発行済みで、second が "inited" なら INITED、
   * "loading" なら LOADING のまま。手番 2 の発行は頼んであり、まだ返っていない
   */
  static started(
    missBelow?: (turn: number) => number | null,
    second: "inited" | "loading" = "inited",
  ): Sim {
    const sim = new Sim(missBelow);
    sim.issueAll().load(0);
    if (second === "inited") sim.load(1);
    sim.send({ type: "begin" }).fire("interlude", INTERLUDE_MS);
    return sim;
  }
  /** 手番を 1 つ遊んで、次の手番が動くところまで（次が INITED のとき） */
  playThrough(score: number): this {
    this.end(score).settleAll().fire("flash", FLASH_MS);
    if (this.state.phase === "interlude") {
      this.issueAll().loadAll().fire("interlude", INTERLUDE_MS);
    }
    return this;
  }
}

describe("定数（run#A.5、A.7、A.9）", () => {
  it("文書の値", () => {
    expect(FLASH_MS).toBe(500);
    expect(INTERLUDE_MS).toBe(1000);
    expect(INTERLUDE_EXTENSION_MS).toBe(3000);
    expect(RESULT_RETRIES).toBe(2);
    expect(RESULT_RETRY_MS).toBe(1000);
    expect(HIDDEN_ABORT_MS).toBe(10 * 60 * 1000);
  });
});

describe("先読みとスタート（run#A.4、A.5）", () => {
  it("R-8.2-3 始まりは 2 手番の発行を頼み、届いた手番を不可視で読み込んで init まで進める", () => {
    const sim = new Sim();
    expect(sim.state).toMatchObject({ phase: "idle", lives: 3, requesting: 2 });
    expect(sim.out).toEqual([{ type: "request_next" }, { type: "request_next" }]);
    sim.issue();
    expect(sim.out).toEqual([{ type: "load", turn: 0 }]);
    sim.send({ type: "ready", turn: 0 });
    expect(sim.out).toEqual([{ type: "init", turn: 0 }]);
    sim.send({ type: "inited", turn: 0 });
    // 不可視スロットに start は送らない
    expect(sim.every("start")).toEqual([]);
    expect(sim.state.pending).toEqual([
      { turn: { turn: 0, sessionId: "s0", missBelow: 30 }, frame: "INITED" },
    ]);
  });

  it("R-8.2-3 スタートの操作で幕間を 1 秒出し、終わりに INITED の手番へ start。空いたスロットの発行を頼む", () => {
    const sim = new Sim();
    sim.issueAll().loadAll().send({ type: "begin" });
    expect(sim.state.phase).toBe("interlude");
    expect(sim.every("start")).toEqual([]);
    sim.fire("interlude", INTERLUDE_MS);
    expect(sim.out).toEqual([{ type: "start", turn: 0 }, { type: "request_next" }]);
    expect(sim.state).toMatchObject({
      phase: "running",
      current: { turn: { turn: 0 }, frame: "RUNNING" },
    });
    expect(sim.state.pending.map((p) => p.turn.turn)).toEqual([1]);
  });

  it("R-8.2-3 手番の切り替え: end → フラッシュ 0.5 秒 → 幕間 1 秒 → 次へ start、前の iframe を destroy、N+2 を頼む", () => {
    const sim = Sim.started();
    sim.issueAll().loadAll();
    expect(aliveFrames(sim.state)).toBe(3);
    sim.end(55);
    expect(sim.effects("send_result")).toEqual([
      { type: "send_result", sessionId: "s0", turn: 0, skipped: false, delayMs: 0 },
    ]);
    expect(sim.state).toMatchObject({ phase: "flash", current: { frame: "ENDED" } });
    sim.fire("flash", FLASH_MS);
    expect(sim.state.phase).toBe("interlude");
    expect(sim.every("start")).toHaveLength(1);
    sim.fire("interlude", INTERLUDE_MS);
    expect(sim.out).toEqual([
      { type: "start", turn: 1 },
      { type: "destroy", turn: 0 },
      { type: "request_next" },
    ]);
    expect(sim.state).toMatchObject({ phase: "running", current: { turn: { turn: 1 } } });
  });

  it("古いタイマー・知らない手番・phase に合わないイベントは拒否し、状態を変えない", () => {
    const sim = Sim.started();
    sim.rejects({ type: "timer", id: 999 }, "stale");
    sim.rejects({ type: "timer", id: 1 }, "stale");
    sim.rejects({ type: "ready", turn: 42 }, "stale");
    sim.rejects({ type: "end", turn: 7, via: "guest", score: 1 }, "stale");
    sim.rejects({ type: "begin" }, "not_allowed");
    sim.rejects({ type: "result_settled", sessionId: "nope" }, "stale");
    sim.rejects({ type: "show" }, "not_allowed");
    sim.end(55);
    sim.rejects({ type: "end", turn: 0, via: "guest", score: 55 }, "not_allowed");
  });
});

describe("skip（run#A.5 の 6、A.6）", () => {
  it("R-8.2-2 幕間の終わりに次が INITED でなければ 3 秒まで延長し、超えたら skip: destroy、{skipped: true}、残機不変、N+2 を繰り上げて空きを埋める", () => {
    const sim = Sim.started(undefined, "loading");
    sim.issueAll();
    // 手番 1 は LOADING のまま、手番 2 は INITED
    sim.load(2).end(55).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.every("start")).toHaveLength(1);
    expect(sim.state.timer?.name).toBe("extension");

    sim.fire("extension", INTERLUDE_EXTENSION_MS);
    expect(sim.effects("destroy")).toEqual([{ type: "destroy", turn: 1 }]);
    expect(sim.effects("send_result")).toEqual([
      { type: "send_result", sessionId: "s1", turn: 1, skipped: true, delayMs: 0 },
    ]);
    expect(sim.effects("request_next")).toHaveLength(1);
    expect(sim.state).toMatchObject({ phase: "interlude", lives: 3, skipped: [1] });
    // 繰り上がった手番 2 が先頭。幕間（手順 4）からやり直す
    expect(sim.state.pending.map((p) => p.turn.turn)).toEqual([2]);
    sim.issueAll().fire("interlude", INTERLUDE_MS);
    expect(sim.effects("start")).toEqual([{ type: "start", turn: 2 }]);
    expect(sim.state.pending.map((p) => p.turn.turn)).toEqual([3]);
  });

  it("R-8.2-2 延長中に INITED になったら、その時点で start する", () => {
    const sim = Sim.started(undefined, "loading");
    sim.issueAll().end(55).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.state.timer?.name).toBe("extension");
    sim.send({ type: "ready", turn: 1 });
    expect(sim.every("start")).toHaveLength(1);
    sim.send({ type: "inited", turn: 1 });
    expect(sim.effects("start")).toEqual([{ type: "start", turn: 1 }]);
    expect(sim.state).toMatchObject({ phase: "running", skipped: [], timer: null });
  });

  it("幕間の終わりに発行の応答がまだなら待ち、手番が届いてから延長を計る", () => {
    const sim = Sim.started();
    // 手番 1 を始めた後も、手番 2・3 の発行が返ってこない
    sim.end(55).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.end(55).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.state).toMatchObject({
      phase: "interlude",
      timer: null,
      pending: [],
      requesting: 2,
    });
    sim.issue();
    expect(sim.state.timer?.name).toBe("extension");
    sim.load(2);
    expect(sim.effects("start")).toEqual([{ type: "start", turn: 2 }]);
  });

  it("timeout / error で終わった手番は skip: 残機は減らず、結果は送る", () => {
    const sim = Sim.started(() => 30);
    sim.end(0, "timeout");
    expect(sim.state).toMatchObject({ lives: 3, last: { via: "timeout", miss: false } });
    expect(sim.effects("send_result")).toHaveLength(1);
  });
});

describe("残機とミス（run#A.7）", () => {
  it("R-run.A7-1 ミスは end の瞬間に score < miss_below で決まり、通信を待たずに残機が減る", () => {
    const sim = Sim.started(() => 30);
    sim.end(29);
    expect(sim.state).toMatchObject({ lives: 2, last: { turn: 0, score: 29, miss: true } });
    expect(Object.keys(sim.state.results)).toEqual(["s0"]);
  });

  it("R-run.A7-1 閾値ちょうど・miss_below: null（新作枠、校正中）はミスにならない（F7）", () => {
    const at = Sim.started(() => 30);
    at.end(30);
    expect(at.state).toMatchObject({ lives: 3, last: { miss: false } });
    const fresh = Sim.started(() => null);
    fresh.end(0);
    expect(fresh.state).toMatchObject({ lives: 3, last: { miss: false } });
  });

  it("R-run.A7-1 3 回目のミスでランが終わり、幕間に進まず start は出ない（F8）。iframe はすべて外す", () => {
    const sim = Sim.started(() => 30);
    sim.playThrough(0).playThrough(0);
    expect(sim.state).toMatchObject({ phase: "running", lives: 1 });
    sim.issueAll().loadAll();
    const starts = sim.every("start").length;
    sim.end(0);
    expect(sim.state).toMatchObject({ phase: "flash", lives: 0 });
    sim.fire("flash", FLASH_MS);
    expect(sim.state.phase).toBe("closing");
    expect(sim.effects("destroy").map((e) => e.turn)).toEqual([2, 3, 4]);
    expect(aliveFrames(sim.state)).toBe(0);
    expect(sim.every("start")).toHaveLength(starts);
    expect(sim.startedAfterZero).toBe(false);
    // 終わった後に届いた発行や ready は捨てる
    sim.rejects({ type: "ready", turn: 3 }, "stale");
  });

  it("R-run.A7-1 result の応答が遅れても進行は変わらない（応答なしで次の手番まで進む）", () => {
    const sim = Sim.started(() => 30);
    sim.issueAll().loadAll();
    sim.end(0).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.state).toMatchObject({ phase: "running", lives: 2, current: { turn: { turn: 1 } } });
    expect(Object.keys(sim.state.results)).toEqual(["s0"]);
    // 遅れて届いた応答は応答待ちを消すだけ
    sim.send({ type: "result_settled", sessionId: "s0" });
    expect(sim.out).toEqual([]);
    expect(sim.state).toMatchObject({ phase: "running", lives: 2, results: {} });
  });

  it("R-run.A7-2 最後の result の応答が届くまで finish を呼ばない", () => {
    const sim = Sim.started(() => 30);
    sim.playThrough(0).playThrough(0);
    sim.end(0).fire("flash", FLASH_MS);
    expect(sim.state.phase).toBe("closing");
    expect(sim.every("finish")).toEqual([]);
    sim.send({ type: "result_settled", sessionId: "s2" });
    expect(sim.out).toEqual([{ type: "finish" }]);
    expect(sim.state.phase).toBe("finished");
    sim.rejects({ type: "abort" }, "not_allowed");
  });

  it("R-run.A7-2 応答が来なければ 1 秒おきに 2 回まで再送し、それでも来なければ finish を呼ぶ", () => {
    const sim = Sim.started(() => 30);
    sim.playThrough(0).playThrough(0);
    sim.end(0).fire("flash", FLASH_MS);
    const resend = {
      type: "send_result",
      sessionId: "s2",
      turn: 2,
      skipped: false,
      delayMs: RESULT_RETRY_MS,
    };
    sim.send({ type: "result_failed", sessionId: "s2" });
    expect(sim.out).toEqual([resend]);
    sim.send({ type: "result_failed", sessionId: "s2" });
    expect(sim.out).toEqual([resend]);
    sim.send({ type: "result_failed", sessionId: "s2" });
    expect(sim.out).toEqual([{ type: "finish" }]);
  });

  it("R-run.A7-2 読み込みの skip の再送は {skipped: true} のまま", () => {
    const sim = Sim.started(undefined, "loading");
    sim.end(55).settleAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.fire("extension", INTERLUDE_EXTENSION_MS);
    sim.send({ type: "result_failed", sessionId: "s1" });
    expect(sim.out).toEqual([
      { type: "send_result", sessionId: "s1", turn: 1, skipped: true, delayMs: RESULT_RETRY_MS },
    ]);
  });
});

describe("ランの終わり（run#A.15 F6）", () => {
  it("サーバが done を返し、次に出す手番が無ければ幕間の終わりに終わる（上限）", () => {
    const sim = Sim.started(() => null);
    // 手番 2 の発行に done が返る
    sim.serverDone();
    expect(sim.state.serverDone).toBe(true);
    sim.end(5).settleAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    // 手番 1 を始めた後は、もう発行を頼まない
    expect(sim.effects("request_next")).toEqual([]);
    sim.end(5).settleAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.out).toEqual([{ type: "destroy", turn: 1 }, { type: "finish" }]);
    expect(sim.state.phase).toBe("finished");
  });

  it("幕間の終わりに発行を待っている間に done が届いたら、そこで終わる", () => {
    const sim = Sim.started(() => null);
    sim.end(5).settleAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.end(5).settleAll().fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.state).toMatchObject({ phase: "interlude", timer: null });
    sim.serverDone();
    expect(sim.state.phase).toBe("interlude");
    sim.serverDone();
    expect(sim.state.phase).toBe("finished");
  });

  it("R-run.A15-1 全手番が読み込みの skip でも、上限の 50 手番で終わる", () => {
    const sim = new Sim();
    const serve = () => {
      while (sim.requested > 0) {
        if (sim.issued < ENDLESS_TURN_LIMIT) sim.issue();
        else sim.serverDone();
      }
    };
    serve();
    sim.send({ type: "begin" });
    let steps = 0;
    while (sim.state.phase !== "finished") {
      expect(++steps, "終わらない").toBeLessThan(1000);
      const name = sim.state.timer?.name;
      if (name === "interlude") sim.fire("interlude", INTERLUDE_MS);
      else if (name === "extension") sim.fire("extension", INTERLUDE_EXTENSION_MS);
      else throw new Error(`止まった: ${sim.state.phase}`);
      sim.settleAll();
      serve();
    }
    expect(sim.state.skipped).toHaveLength(ENDLESS_TURN_LIMIT);
    expect(sim.every("start")).toEqual([]);
    expect(sim.every("send_result").filter((e) => e.skipped)).toHaveLength(ENDLESS_TURN_LIMIT);
    expect(sim.every("finish")).toHaveLength(1);
    expect(sim.state.lives).toBe(3);
  });

  it("どんな順でイベントが来ても不変条件（F1〜F5、F8）を保ち、ランは終わる", () => {
    // seed から決まる乱数で、ラン画面とサーバのふるまいを揺らす
    for (let seed = 1; seed <= 200; seed++) {
      let a = seed;
      const rand = () => {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        return a / 0x7fffffff;
      };
      const sim = new Sim((turn) => (turn % 4 === 0 ? null : 30));
      const cap = 12;
      let steps = 0;
      sim.send({ type: "begin" });
      while (sim.state.phase !== "finished") {
        expect(++steps, `seed ${seed} が終わらない`).toBeLessThan(2000);
        const s = sim.state;
        const options: (() => void)[] = [];
        if (sim.requested > 0) {
          options.push(() => (sim.issued < cap ? sim.issue() : sim.serverDone()));
        }
        for (const p of s.pending) {
          if (p.frame === "LOADING")
            options.push(() => sim.send({ type: "ready", turn: p.turn.turn }));
          if (p.frame === "READY")
            options.push(() => sim.send({ type: "inited", turn: p.turn.turn }));
        }
        if (s.timer) {
          const id = s.timer.id;
          options.push(() => sim.send({ type: "timer", id }));
        }
        if (
          s.current &&
          s.current.frame !== "ENDED" &&
          (s.phase === "running" || s.phase === "resuming")
        ) {
          const via = rand() < 0.2 ? "timeout" : "guest";
          options.push(() => sim.end(via === "guest" ? Math.floor(rand() * 60) : 0, via));
        }
        for (const id of Object.keys(s.results)) {
          options.push(() => sim.send({ type: "result_settled", sessionId: id }));
          options.push(() => sim.send({ type: "result_failed", sessionId: id }));
        }
        if (s.phase !== "closing")
          options.push(() => sim.send({ type: s.hidden ? "show" : "hide" }));
        expect(options.length, `seed ${seed} が ${s.phase} で止まった`).toBeGreaterThan(0);
        options[Math.floor(rand() * options.length)]?.();
      }
      expect(sim.startedAfterZero).toBe(false);
      expect(sim.every("finish")).toHaveLength(1);
      expect(aliveFrames(sim.state)).toBe(0);
    }
  });
});

describe("中断と再開（run#A.9）", () => {
  it("非表示で pause、表示に戻ったら「続きから」の幕間 1 秒の後に resume", () => {
    const sim = Sim.started();
    sim.send({ type: "hide" });
    expect(sim.out).toEqual([{ type: "pause", turn: 0 }]);
    expect(sim.state).toMatchObject({
      phase: "running",
      hidden: true,
      current: { frame: "PAUSED" },
    });
    sim.send({ type: "show" });
    expect(sim.state.phase).toBe("resuming");
    expect(sim.every("resume")).toEqual([]);
    sim.fire("resume", INTERLUDE_MS);
    expect(sim.out).toEqual([{ type: "resume", turn: 0 }]);
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

  it("非表示の間に幕間が終わっても start せず、表示に戻ってから幕間を出し直す", () => {
    const sim = Sim.started();
    sim.issueAll().loadAll().end(55).send({ type: "hide" });
    sim.fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    expect(sim.every("start")).toHaveLength(1);
    expect(sim.state).toMatchObject({ phase: "interlude", timer: null });
    sim.send({ type: "show" }).fire("interlude", INTERLUDE_MS);
    expect(sim.effects("start")).toEqual([{ type: "start", turn: 1 }]);
  });

  it("中断（abort）: iframe をすべて外し、送った result の応答を待ってから finish", () => {
    const sim = Sim.started();
    sim.issueAll().loadAll().end(55).fire("flash", FLASH_MS).fire("interlude", INTERLUDE_MS);
    sim.send({ type: "hide" }).send({ type: "abort" });
    expect(sim.out.map((e) => e.type)).toEqual(["destroy", "destroy"]);
    expect(sim.state.phase).toBe("closing");
    sim.send({ type: "result_settled", sessionId: "s0" });
    expect(sim.out).toEqual([{ type: "finish" }]);
  });
});
