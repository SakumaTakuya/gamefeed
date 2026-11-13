// Host 側ブリッジ（protocol#A.2, A.5〜A.9）。Guest ランタイムとメモリ上でつないで検査する。
import type { GameMeta } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import { createGuest } from "../src/guest.ts";
import { createHost } from "../src/host.ts";
import type { GuestToHost, HostToGuest } from "../src/messages.ts";

const META: GameMeta = {
  title: "まるタップ",
  verb: "タップ！",
  input: "tap",
  duration: 180,
  target: 3,
};

function setup(opts: { connect?: boolean } = {}) {
  const clock = { t: 0 };
  const toGuest: HostToGuest[] = [];
  const fromGuest: GuestToHost[] = [];
  let timer: { cb: () => void; at: number } | null = null;
  let changes = 0;
  let sessions = 0;

  const host = createHost(
    {
      post: (m) => {
        toGuest.push(m);
        if (opts.connect !== false) guest.receive(m);
      },
      now: () => clock.t,
      setTimer: (cb, ms) => {
        timer = { cb, at: clock.t + ms };
        return timer;
      },
      clearTimer: (h) => {
        if (timer === h) timer = null;
      },
      newSessionId: () => `s-${++sessions}`,
      newSeed: () => 42,
    },
    () => changes++,
  );
  const guest = createGuest({
    post: (m) => {
      fromGuest.push(m);
      host.receive(m);
    },
    now: () => clock.t,
  });
  /** 実時間を進める。Guest の描画タイミングと Host のタイマーの両方を動かす */
  const advance = (ms: number, stepMs = 1000 / 60) => {
    const until = clock.t + ms;
    while (clock.t < until) {
      clock.t = Math.min(until, clock.t + stepMs);
      guest.frame();
      if (timer && clock.t >= timer.at) {
        const { cb } = timer;
        timer = null;
        cb();
      }
    }
  };
  return {
    host,
    guest,
    toGuest,
    fromGuest,
    clock,
    advance,
    changes: () => changes,
    hasTimer: () => timer !== null,
  };
}

describe("1 セッションの流れ（pr#A.4, A.5）", () => {
  it("ready → init → start → log → end で ENDED（via: guest）。入力ログが連結される", () => {
    const { host, guest, toGuest, advance } = setup();
    guest.GF.onTick((f) => {
      if (f === 10 || f === 100) guest.input("tap", [0.5, 0.5]);
    });
    guest.GF.onInput(() => {
      guest.GF.score += 1;
    });
    expect(host.state.kind).toBe("LOADING");
    guest.ready(META);
    expect(host.state).toEqual({ kind: "READY", meta: META });

    expect(host.init()).toBe(true);
    expect(toGuest).toEqual([
      { type: "init", session_id: "s-1", seed: 42, mode: "play", time_limit: 180, speed: 1 },
    ]);
    expect(host.start()).toBe(true);
    expect(host.state.kind).toBe("RUNNING");
    advance(3100);

    expect(host.state).toMatchObject({
      kind: "ENDED",
      result: { score: 2, frames: 180, via: "guest", flagged: false, scoreable: true },
    });
    expect(host.inputs).toEqual([
      [11, "tap", 0.5, 0.5],
      [101, "tap", 0.5, 0.5],
    ]);
    expect(host.problem).toBeNull();
  });

  it("init は READY と ENDED でだけ、start は INITED でだけ送る", () => {
    const { host, guest, toGuest, advance } = setup();
    expect(host.init()).toBe(false);
    expect(host.start()).toBe(false);
    guest.ready(META);
    expect(host.start()).toBe(false);
    expect(host.init({ speed: 1.5 })).toBe(true);
    expect(host.init()).toBe(false);
    expect(host.start()).toBe(true);
    expect(host.start()).toBe(false);
    expect(toGuest.map((m) => m.type)).toEqual(["init", "start"]);
    expect(toGuest[0]).toMatchObject({ speed: 1.5 });
    advance(2100);
    expect(host.state.kind).toBe("ENDED");
  });

  it("ENDED から init し直すと、新しい session_id で遊び直せる（pr#A.6）。入力ログは空に戻る", () => {
    const { host, guest, advance } = setup();
    guest.GF.onTick((f) => {
      if (f === 5) guest.input("tap", [0.1, 0.1]);
    });
    guest.ready(META);
    host.init();
    host.start();
    advance(3100);
    expect(host.inputs.length).toBe(1);

    expect(host.init()).toBe(true);
    expect(host.state).toMatchObject({ kind: "INITED", sessionId: "s-2" });
    expect(host.inputs).toEqual([]);
    host.start();
    advance(3100);
    expect(host.state).toMatchObject({ kind: "ENDED", sessionId: "s-2", result: { via: "guest" } });
  });

  it("状態が変わるたびに onChange が呼ばれる", () => {
    const { host, guest, advance, changes } = setup();
    guest.ready(META);
    const afterReady = changes();
    expect(afterReady).toBeGreaterThan(0);
    host.init();
    host.start();
    advance(3100);
    expect(changes()).toBeGreaterThan(afterReady + 2);
  });
});

describe("監視タイマー（pr#A.7）", () => {
  it("Guest が end を送らなければ、time_limit ÷ (60 × speed) 秒 + 1.5 秒で timeout になる", () => {
    const { host, guest, clock, advance, hasTimer } = setup();
    guest.ready(META);
    host.init();
    // 何も送らない Guest（固まったゲーム）の代わりに、Guest 側だけ破棄しておく
    guest.receive({ type: "destroy" });
    host.start();
    expect(hasTimer()).toBe(true);
    advance(4400);
    expect(host.state.kind).toBe("RUNNING");
    advance(200);
    expect(clock.t).toBeGreaterThanOrEqual(4500);
    expect(host.state).toMatchObject({
      kind: "ENDED",
      result: { score: 0, frames: 180, via: "timeout" },
    });
    expect(hasTimer()).toBe(false);
  });

  it("pause 中は満了せず、resume で残り時間から再開する", () => {
    const { host, guest, advance } = setup();
    guest.ready(META);
    host.init();
    guest.receive({ type: "destroy" });
    host.start();
    advance(4000);
    expect(host.pause()).toBe(true);
    expect(host.state.kind).toBe("PAUSED");
    advance(60_000);
    expect(host.state.kind).toBe("PAUSED");
    expect(host.resume()).toBe(true);
    advance(400);
    expect(host.state.kind).toBe("RUNNING");
    advance(200);
    expect(host.state.kind).toBe("ENDED");
  });

  it("end で終わったらタイマーを止める", () => {
    const { host, guest, advance, hasTimer } = setup();
    guest.ready(META);
    host.init();
    host.start();
    advance(3100);
    expect(host.state.kind).toBe("ENDED");
    expect(hasTimer()).toBe(false);
  });
});

describe("error と破棄（pr#A.2, A.7）", () => {
  it("Guest の error で ENDED（via: error）になり、メッセージが残る", () => {
    const { host, guest, advance } = setup();
    guest.GF.onTick((f) => {
      if (f === 3) throw new Error("boom");
    });
    guest.ready(META);
    host.init();
    host.start();
    advance(500);
    expect(host.state).toMatchObject({ kind: "ENDED", result: { via: "error", score: 0 } });
    expect(host.problem).toBe("Error: boom");
    // 遊び直すと消える
    host.init();
    expect(host.problem).toBeNull();
  });

  it("R-6.1-1: スキーマ違反（余計なキー・型違い・未知の type・Host 発の type）は destroy を送って破棄する", () => {
    for (const bad of [
      { type: "end", session_id: "s-1", score: 1, frames: 1, extra: true },
      { type: "end", session_id: "s-1", score: -1, frames: 1 },
      { type: "media", data: "x" },
      { type: "start" },
      null,
      "ready",
    ]) {
      const { host, guest, toGuest } = setup({ connect: false });
      guest.ready(META);
      host.init();
      host.start();
      host.receive(bad);
      expect(host.state.kind, JSON.stringify(bad)).toBe("DESTROYED");
      expect(toGuest.at(-1)).toEqual({ type: "destroy" });
      expect(host.problem).toMatch(/^プロトコル違反/);
      // 以後は何も受けず、何も送らない
      const sent = toGuest.length;
      host.receive({ type: "end", session_id: "s-1", score: 1, frames: 1 });
      expect(host.init()).toBe(false);
      expect(toGuest.length).toBe(sent);
    }
  });

  it("知らないメジャーの sdk を名乗る ready は破棄する（pr#A.2）", () => {
    const { host, toGuest } = setup({ connect: false });
    host.receive({ type: "ready", sdk: "3.0", ...META });
    expect(host.state.kind).toBe("DESTROYED");
    expect(toGuest).toEqual([{ type: "destroy" }]);
  });

  it("古い session_id の end は捨てる（破棄はしない）", () => {
    const { host, guest } = setup({ connect: false });
    guest.ready(META);
    host.init();
    host.start();
    host.receive({ type: "end", session_id: "old", score: 9, frames: 9 });
    expect(host.state.kind).toBe("RUNNING");
  });

  it("log の順序違反は捨てて flagged を残す（pr#A.9）", () => {
    const { host, guest } = setup({ connect: false });
    guest.ready(META);
    host.init();
    host.start();
    host.receive({
      type: "log",
      session_id: "s-1",
      from_frame: 64,
      inputs: [[70, "tap", 0.5, 0.5]],
    });
    host.receive({ type: "log", session_id: "s-1", from_frame: 0, inputs: [[1, "tap", 0.5, 0.5]] });
    expect(host.inputs).toEqual([[70, "tap", 0.5, 0.5]]);
    host.receive({ type: "end", session_id: "s-1", score: 1, frames: 100 });
    expect(host.state).toMatchObject({ kind: "ENDED", result: { flagged: true } });
  });

  it("destroy はどの状態からも効き、destroy を送ってタイマーを止める", () => {
    const { host, guest, toGuest, hasTimer } = setup();
    host.destroy();
    expect(host.state.kind).toBe("DESTROYED");
    expect(toGuest).toEqual([{ type: "destroy" }]);

    const s = setup();
    s.guest.ready(META);
    s.host.init();
    s.host.start();
    s.host.destroy();
    expect(s.hasTimer()).toBe(false);
    s.host.destroy();
    expect(s.toGuest.filter((m) => m.type === "destroy").length).toBe(1);
    expect(guest.state).toBe("DESTROYED");
    expect(hasTimer()).toBe(false);
  });
});
