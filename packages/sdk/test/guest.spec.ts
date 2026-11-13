// Guest ランタイム本体（protocol#A.2〜A.10、gc#A.4）。DOM なしで、送信と時計を差し替えて検査する。
import { type GameMeta, initialSession, type SessionState, transition } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import { createGuest, type Guest } from "../src/guest.ts";
import {
  type GuestToHost,
  type HostToGuest,
  parseGuestMessage,
  SCORE_MAX,
  toSessionEvent,
} from "../src/messages.ts";

const META: GameMeta = {
  title: "まるタップ",
  verb: "タップ！",
  input: "tap",
  duration: 300,
  target: 12,
};
const SID = "s-1";

function setup() {
  const sent: GuestToHost[] = [];
  const clock = { t: 1000 };
  const guest = createGuest({ post: (m) => sent.push(m), now: () => clock.t });
  const init = (over: Partial<Extract<HostToGuest, { type: "init" }>> = {}) =>
    guest.receive({
      type: "init",
      session_id: SID,
      seed: 42,
      mode: "play",
      time_limit: 300,
      speed: 1,
      ...over,
    });
  /** 実時間を ms 進めて、描画タイミングを 1 回起こす */
  const step = (ms: number) => {
    clock.t += ms;
    guest.frame();
  };
  /** 60 fps で sec 秒ぶん回す */
  const run = (sec: number, fps = 60) => {
    for (let i = 0; i < Math.round(sec * fps); i++) step(1000 / fps);
  };
  const ofType = <T extends GuestToHost["type"]>(type: T) =>
    sent.filter((m): m is Extract<GuestToHost, { type: T }> => m.type === type);
  return { guest, sent, clock, init, step, run, ofType };
}

function started(over: Parameters<ReturnType<typeof setup>["init"]>[0] = {}) {
  const s = setup();
  s.guest.ready(META);
  s.init(over);
  s.guest.receive({ type: "start" });
  return s;
}

describe("ready と Host メッセージの受理（pr#A.4, A.10）", () => {
  it("ready は 1 回だけ送られ、メタ宣言と sdk 2.0 が載る", () => {
    const { guest, sent } = setup();
    guest.ready(META);
    guest.ready(META);
    expect(sent).toEqual([{ type: "ready", sdk: "2.0", ...META }]);
  });

  it("R-6.1-2: ready より前に届いた init は捨てる（onInit が呼ばれない）", () => {
    const { guest, init, sent } = setup();
    let inits = 0;
    guest.GF.onInit(() => inits++);
    init();
    expect(inits).toBe(0);
    guest.ready(META);
    expect(sent.map((m) => m.type)).toEqual(["ready"]);
    init();
    expect(inits).toBe(1);
  });

  it("init で onInit({seed, mode})、start で onStart。start の前はフレームが進まない", () => {
    const { guest, init, step } = setup();
    const calls: string[] = [];
    guest.GF.onInit((a) => calls.push(`init:${a.seed}:${a.mode}`));
    guest.GF.onStart(() => calls.push("start"));
    guest.GF.onTick((f) => calls.push(`tick:${f}`));
    guest.ready(META);
    init();
    step(100);
    expect(calls).toEqual(["init:42:play"]);
    guest.receive({ type: "start" });
    step(17);
    expect(calls).toEqual(["init:42:play", "start", "tick:0"]);
  });

  it("start は INITED でだけ、pause は RUNNING でだけ、resume は PAUSED でだけ受理する", () => {
    const { guest, init } = setup();
    let starts = 0;
    guest.GF.onStart(() => starts++);
    guest.ready(META);
    guest.receive({ type: "start" });
    guest.receive({ type: "pause" });
    guest.receive({ type: "resume" });
    expect(guest.state).toBe("READY");
    init();
    guest.receive({ type: "resume" });
    expect(guest.state).toBe("INITED");
    guest.receive({ type: "start" });
    guest.receive({ type: "start" });
    expect(starts).toBe(1);
    guest.receive({ type: "pause" });
    expect(guest.state).toBe("PAUSED");
    guest.receive({ type: "resume" });
    expect(guest.state).toBe("RUNNING");
  });

  it("play の RUNNING 中の init は捨て、ENDED からの init は受理する（pr#A.6）", () => {
    const { guest, init, run, ofType } = started({ time_limit: 60 });
    let inits = 0;
    guest.GF.onInit(() => inits++);
    init({ session_id: "s-2" });
    expect(inits).toBe(0);
    run(1.1);
    expect(guest.state).toBe("ENDED");
    init({ session_id: "s-2", time_limit: 60 });
    expect(inits).toBe(1);
    expect(guest.GF.frame).toBe(0);
    guest.receive({ type: "start" });
    run(1.1);
    expect(ofType("end").map((m) => m.session_id)).toEqual([SID, "s-2"]);
  });

  it("R-6.1-1: スキーマ違反（余計なキー・型違い・未知の type・Guest 発の type）の後はすべて無視する", () => {
    for (const bad of [
      { type: "start", extra: 1 },
      { type: "init", session_id: SID, seed: "x", mode: "play", time_limit: 300, speed: 1 },
      { type: "media" },
      { type: "end", session_id: SID, score: 1, frames: 1 },
      null,
      "start",
    ]) {
      const { guest, init, sent, run } = setup();
      let calls = 0;
      guest.GF.onInit(() => calls++);
      guest.GF.onTick(() => calls++);
      guest.ready(META);
      guest.receive(bad);
      init();
      guest.receive({ type: "start" });
      run(0.5);
      expect(calls, JSON.stringify(bad)).toBe(0);
      expect(sent.map((m) => m.type)).toEqual(["ready"]);
      expect(guest.state).toBe("DESTROYED");
    }
  });

  it("destroy の後はコールバックを呼ばず、何も送らない", () => {
    const { guest, sent, run } = started();
    let ticks = 0;
    guest.GF.onTick(() => ticks++);
    run(0.1);
    const before = { ticks, sent: sent.length };
    guest.receive({ type: "destroy" });
    run(6);
    guest.GF.end();
    expect({ ticks, sent: sent.length }).toEqual(before);
    expect(guest.state).toBe("DESTROYED");
  });
});

describe("tick ループ（pr#A.4, A.8）", () => {
  it("speed × 60 回/秒で onTick を呼ぶ。フレーム番号は 0 から連番", () => {
    for (const [speed, expected] of [
      [1, 60],
      [1.5, 90],
    ] as const) {
      const { guest, run } = started({ speed, time_limit: 600 });
      const frames: number[] = [];
      guest.GF.onTick((f) => frames.push(f));
      run(1);
      expect(frames.length, `speed ${speed}`).toBe(expected);
      expect(frames).toEqual(frames.map((_, i) => i));
    }
  });

  it("遅れたときは 1 描画あたり最大 5 tick まで追いつき、残りは次に持ち越す", () => {
    const { guest, step } = started({ time_limit: 600 });
    let ticks = 0;
    guest.GF.onTick(() => ticks++);
    step(500); // 30 tick ぶん遅れた
    expect(ticks).toBe(5);
    step(0);
    expect(ticks).toBe(10);
    for (let i = 0; i < 10; i++) step(0);
    expect(ticks).toBe(30);
  });

  it("onDraw は描画ごとに 1 回、tick の後に呼ばれ、alpha は 0 以上 1 未満", () => {
    const { guest, step } = started();
    const order: string[] = [];
    const alphas: number[] = [];
    guest.GF.onTick(() => order.push("tick"));
    guest.GF.onDraw((a) => {
      order.push("draw");
      alphas.push(a);
    });
    step(25); // 1.5 tick ぶん
    step(5); // 次の tick に届かない
    expect(order).toEqual(["tick", "draw", "draw"]);
    expect(alphas[0]).toBeCloseTo(0.5);
    for (const a of alphas) expect(a >= 0 && a < 1).toBe(true);
  });

  it("pause 中はフレームも壁時計も進まず、resume で続きから進む", () => {
    const { guest, run, ofType } = started({ time_limit: 120 });
    run(1);
    expect(guest.GF.frame).toBe(60);
    guest.receive({ type: "pause" });
    run(10);
    expect(guest.GF.frame).toBe(60);
    expect(ofType("end")).toEqual([]);
    guest.receive({ type: "resume" });
    run(0.5);
    expect(guest.GF.frame).toBe(90);
    run(0.6);
    expect(ofType("end")).toEqual([{ type: "end", session_id: SID, score: 0, frames: 120 }]);
  });

  it("GF.timeLimit / timeLeft / frame が tick ごとに更新される", () => {
    const { guest, run } = started({ time_limit: 300 });
    const seen: [number, number][] = [];
    guest.GF.onTick((f) => seen.push([guest.GF.frame, guest.GF.timeLeft]));
    run(0.05);
    expect(guest.GF.timeLimit).toBe(300);
    expect(seen).toEqual([
      [0, 300],
      [1, 299],
      [2, 298],
    ]);
  });
});

describe("end（pr#A.4, gc#A.4）", () => {
  it("R-6.3-4: time_limit に達したら、そのときの GF.score で end を 1 回送る", () => {
    const { guest, run, ofType, sent } = started({ time_limit: 300 });
    guest.GF.onTick(() => {
      guest.GF.score += 1;
    });
    run(6);
    expect(ofType("end")).toEqual([{ type: "end", session_id: SID, score: 300, frames: 300 }]);
    expect(sent.at(-1)?.type).toBe("end");
    expect(sent.at(-2)?.type).toBe("log");
    expect(guest.state).toBe("ENDED");
  });

  it("R-6.3-4: GF.end() は 1 回だけ効き、その tick で終わる。以後の tick は止まる", () => {
    const { guest, run, ofType } = started();
    let ticks = 0;
    guest.GF.onTick((f) => {
      ticks++;
      guest.GF.score = 7;
      if (f >= 9) {
        guest.GF.end();
        guest.GF.end();
      }
    });
    run(2);
    guest.GF.end();
    expect(ticks).toBe(10);
    expect(ofType("end")).toEqual([{ type: "end", session_id: SID, score: 7, frames: 10 }]);
  });

  it("start の前や onStart で呼んだ GF.end() でも frames は 1 以上になる", () => {
    const { guest, init, run, ofType } = setup();
    guest.GF.onInit(() => guest.GF.end());
    guest.GF.onStart(() => guest.GF.end());
    guest.ready(META);
    init();
    expect(ofType("end")).toEqual([]);
    guest.receive({ type: "start" });
    run(0.1);
    expect(ofType("end")).toEqual([{ type: "end", session_id: SID, score: 0, frames: 1 }]);
  });

  it("R-pr.A4-1: 遅い端末（描画 12 回/秒、speed 1.5、600 フレーム）でも壁時計で end を送り、frames < 600", () => {
    const { run, ofType, clock } = started({ speed: 1.5, time_limit: 600 });
    const t0 = clock.t;
    run(8, 12);
    const [end] = ofType("end");
    expect(end).toBeDefined();
    expect(end?.frames).toBeLessThan(600);
    expect(end?.frames).toBeGreaterThan(0);
    // 監視タイマー（time_limit ÷ (60 × speed) 秒 + 1.5 秒）より前に届いている
    expect(ofType("end").length).toBe(1);
    const deadline = 600 / (60 * 1.5);
    expect(end && end.frames <= deadline * 12 * 5 + 5).toBe(true);
    expect(clock.t - t0).toBeGreaterThanOrEqual(deadline * 1000);
  });

  it("R-gc.A4-1: GF.score は end で整数・0 以上・2^31−1 以下にクランプされる", () => {
    for (const [value, expected] of [
      [-5, 0],
      [3.9, 3],
      [SCORE_MAX + 10, SCORE_MAX],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, SCORE_MAX],
      ["12", 12],
      ["abc", 0],
      [undefined, 0],
    ] as const) {
      const { guest, run, ofType } = started({ time_limit: 1 });
      guest.GF.onTick(() => {
        (guest.GF as { score: unknown }).score = value;
      });
      run(0.1);
      expect(ofType("end")[0]?.score, String(value)).toBe(expected);
    }
  });

  it("init で GF.score と frame が 0 に戻る", () => {
    const { guest, init, run } = started({ time_limit: 10 });
    guest.GF.onTick(() => {
      guest.GF.score += 2;
    });
    run(0.5);
    expect(guest.GF.score).toBe(20);
    init({ session_id: "s-2" });
    expect(guest.GF.score).toBe(0);
    expect(guest.GF.frame).toBe(0);
  });
});

describe("入力と log（pr#A.4, A.9）", () => {
  it("入力は次の tick のフレーム番号で記録され、その tick の onTick より前に onInput へ渡る", () => {
    const { guest, step, ofType, run } = started({ time_limit: 10 });
    const order: string[] = [];
    guest.GF.onInput((ev) => order.push(`input:${ev.frame}:${ev.kind}:${ev.data.join(",")}`));
    guest.GF.onTick((f) => order.push(`tick:${f}`));
    step(17); // tick 0
    guest.input("tap", [0.25, 0.5]);
    guest.input("tap", [0.75, 0.5]);
    expect(order).toEqual(["tick:0"]);
    step(17); // tick 1
    expect(order).toEqual(["tick:0", "input:1:tap:0.25,0.5", "input:1:tap:0.75,0.5", "tick:1"]);
    run(0.5);
    expect(ofType("log")).toEqual([
      {
        type: "log",
        session_id: SID,
        from_frame: 0,
        inputs: [
          [1, "tap", 0.25, 0.5],
          [1, "tap", 0.75, 0.5],
        ],
      },
    ]);
  });

  it("log は 64 フレームごとと end の直前に送られ、from_frame は厳密に増える", () => {
    const { guest, run, sent } = started({ time_limit: 150 });
    guest.GF.onTick((f) => {
      if (f === 10 || f === 70 || f === 140) guest.input("tap", [0.5, 0.5]);
    });
    run(3);
    const logs = sent.filter((m) => m.type === "log");
    expect(logs.map((m) => [m.from_frame, m.inputs.map((e) => e[0])])).toEqual([
      [0, [11]],
      [64, [71]],
      [128, [141]],
    ]);
    expect(sent.map((m) => m.type)).toEqual(["ready", "log", "log", "log", "end"]);
  });

  it("start の前・pause 中・end の後の入力は記録しない", () => {
    const { guest, init, run, ofType } = setup();
    let inputs = 0;
    guest.GF.onInput(() => inputs++);
    guest.ready(META);
    guest.input("tap", [0.1, 0.1]);
    init({ time_limit: 30 });
    guest.input("tap", [0.2, 0.2]);
    guest.receive({ type: "start" });
    run(0.1);
    guest.receive({ type: "pause" });
    guest.input("tap", [0.3, 0.3]);
    guest.receive({ type: "resume" });
    run(1);
    guest.input("tap", [0.4, 0.4]);
    expect(inputs).toBe(0);
    expect(ofType("log").flatMap((m) => m.inputs)).toEqual([]);
  });

  it("最後の tick の後に届いた入力は log に入らない（log の最大フレーム ≤ end.frames）", () => {
    const { guest, run, ofType } = started({ time_limit: 5 });
    guest.GF.onTick((f) => {
      if (f === 4) guest.input("tap", [0.5, 0.5]);
    });
    run(0.5);
    expect(ofType("log").flatMap((m) => m.inputs)).toEqual([]);
    expect(ofType("end")[0]?.frames).toBe(5);
  });
});

describe("error（pr#A.10）", () => {
  it("R-pr.A10-1: onTick の例外で error を 1 回だけ送り、以後そのセッションでは何も送らない", () => {
    const { guest, run, sent } = started();
    guest.GF.onTick((f) => {
      if (f >= 3) throw new Error("boom");
    });
    run(6);
    expect(sent.map((m) => m.type)).toEqual(["ready", "error"]);
    expect(sent[1]).toEqual({ type: "error", session_id: SID, message: "Error: boom" });
    expect(guest.state).toBe("ENDED");
  });

  it("onInit / onStart / onInput / onDraw の例外も error になる", () => {
    for (const where of ["onInit", "onStart", "onInput", "onDraw"] as const) {
      const { guest, init, run, ofType } = setup();
      guest.GF[where](() => {
        throw new Error(where);
      });
      guest.ready(META);
      init();
      guest.receive({ type: "start" });
      guest.input("tap", [0.5, 0.5]);
      run(6);
      expect(
        ofType("error").map((m) => m.message),
        where,
      ).toEqual([`Error: ${where}`]);
      expect(ofType("end"), where).toEqual([]);
    }
  });

  it("R-pr.A10-1: end の後の例外は無視する。長いメッセージは切り詰める", () => {
    const { guest, run, ofType, step } = started({ time_limit: 5 });
    guest.GF.onDraw(() => {
      if (guest.state === "ENDED") throw new Error("after end");
    });
    run(0.5);
    step(17);
    expect(ofType("end").length).toBe(1);
    expect(ofType("error")).toEqual([]);

    const s = started();
    s.guest.GF.onTick(() => {
      throw new Error("x".repeat(5000));
    });
    s.run(0.1);
    expect(s.ofType("error")[0]?.message.length).toBe(500);
  });
});

describe("乱数と replay（gc#A.4, pr#A.8）", () => {
  it("GF.rng() は 0 以上 1 未満で、同じ seed から同じ列、違う seed から違う列になる", () => {
    const seq = (seed: number) => {
      const { guest, init } = setup();
      guest.ready(META);
      init({ seed });
      return Array.from({ length: 50 }, () => guest.GF.rng());
    };
    const a = seq(42);
    expect(a).toEqual(seq(42));
    expect(a).not.toEqual(seq(43));
    for (const x of a) expect(x >= 0 && x < 1).toBe(true);
    // アルゴリズムを変えると過去のリプレイが崩れるので、値を固定する（mulberry32）
    expect(a.slice(0, 3)).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  });

  /** 乱数と入力の両方に結果が依存するゲーム */
  function install(guest: Guest) {
    let target = 0;
    guest.GF.onInit(() => {
      target = guest.GF.rng();
    });
    guest.GF.onInput((ev) => {
      if (Math.abs((ev.data[0] ?? 0) - target) < 0.3) guest.GF.score += 10;
      target = guest.GF.rng();
    });
    guest.GF.onTick((f) => {
      if (f % 50 === 0) guest.GF.score += 1;
    });
  }

  it("R-pr.A8-1: play の入力ログを replay に渡すと、speed が同じなら同じ end になる（1.0 と 1.5）", () => {
    for (const speed of [1, 1.5] as const) {
      const play = setup();
      install(play.guest);
      play.guest.ready(META);
      play.init({ speed, time_limit: 200 });
      play.guest.receive({ type: "start" });
      for (let i = 0; i < 400; i++) {
        if (i % 7 === 0) play.guest.input("tap", [(i % 10) / 10, 0.5]);
        play.step(1000 / 60);
      }
      const end = play.ofType("end")[0];
      const inputs = play.ofType("log").flatMap((m) => m.inputs);
      expect(end?.score).toBeGreaterThan(4);

      const replay = setup();
      install(replay.guest);
      replay.guest.ready(META);
      replay.init({ mode: "replay", speed, time_limit: 200, inputs });
      replay.guest.receive({ type: "start" });
      // replay 中の DOM 入力は無視される
      replay.guest.input("tap", [0.5, 0.5]);
      replay.run(5, 30);
      expect(replay.ofType("end")[0], `speed ${speed}`).toEqual(end);
      expect(replay.ofType("log").flatMap((m) => m.inputs)).toEqual(inputs);
    }
  });

  it("replay の RUNNING 中の init は受理する（pr#A.10）", () => {
    const { guest, init, run } = setup();
    let inits = 0;
    guest.GF.onInit(() => inits++);
    guest.ready(META);
    init({ mode: "replay", inputs: [] });
    guest.receive({ type: "start" });
    run(0.5);
    init({ mode: "replay", inputs: [], session_id: "s-2" });
    expect(inits).toBe(2);
    expect(guest.state).toBe("INITED");
  });
});

describe("Host の状態機械とのかみ合わせ（pr#A.5, A.9）", () => {
  it("Guest が送る列を Host の状態機械に通すと、flagged なしで ENDED（via: guest）になる", () => {
    const { guest, run, sent } = started({ time_limit: 300 });
    guest.GF.onTick((f) => {
      if (f % 20 === 0) guest.input("tap", [0.5, 0.5]);
      guest.GF.score += 1;
    });
    run(6);

    let state: SessionState = initialSession();
    const feed = (raw: unknown, host = false) => {
      const event = host
        ? toSessionEvent(raw as HostToGuest)
        : (() => {
            const p = parseGuestMessage(raw);
            if (!p.ok) throw new Error(p.reason);
            return toSessionEvent(p.message);
          })();
      const r = transition(state, event, 0);
      expect(r.ok, JSON.stringify(raw)).toBe(true);
      state = r.state;
    };
    feed(sent[0]);
    feed(
      { type: "init", session_id: SID, seed: 42, mode: "play", time_limit: 300, speed: 1 },
      true,
    );
    feed({ type: "start" }, true);
    for (const m of sent.slice(1)) feed(m);
    expect(state.kind).toBe("ENDED");
    expect(state).toMatchObject({
      result: { score: 300, frames: 300, via: "guest", flagged: false },
    });
  });
});
