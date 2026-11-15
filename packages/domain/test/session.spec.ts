import { describe, expect, it } from "vitest";
import { SCORE_MAX } from "../src/result.ts";
import {
  ALLOWED,
  EVENT_TYPES,
  type GameMeta,
  initialSession,
  isSpeed,
  ranMs,
  type SessionEvent,
  type SessionState,
  SPEEDS,
  type Speed,
  STATE_KINDS,
  transition,
  WATCHDOG_GRACE_MS,
  watchdogMs,
} from "../src/session.ts";
import { checkPlayed, hostRealtimeOk, readTurnResult } from "../src/turn-result.ts";

const meta: GameMeta = { title: "押せ", verb: "押せ！", input: "tap", duration: 300, target: 12 };
const SID = "s1";
const end = (frames: number, score = 1, sessionId = SID) =>
  ({ type: "end", sessionId, score, frames }) as const;
const log = (fromFrame: number, inputFrames: number[] = [], sessionId = SID) =>
  ({ type: "log", sessionId, fromFrame, inputFrames }) as const;

/** 典型の経路を一気に進めるヘルパ。各ステップは ok であることを前提にする。 */
function run(
  state: SessionState,
  steps: Parameters<typeof transition>[1][],
  now = 0,
): SessionState {
  let s = state;
  for (const e of steps) {
    const r = transition(s, e, now);
    if (!r.ok) throw new Error(`unexpected reject: ${e.type} in ${s.kind}: ${r.reason}`);
    s = r.state;
  }
  return s;
}

const toReady = () => run(initialSession(), [{ type: "ready", meta }]);
const toInited = (mode: "play" | "replay" = "play", speed: Speed = 1) =>
  run(toReady(), [{ type: "init", sessionId: SID, mode, timeLimit: 300, speed }]);
const toRunning = (now = 0, speed: Speed = 1) =>
  run(toInited("play", speed), [{ type: "start" }], now);

describe("R-6.4-3 典型: ready → init → start → end", () => {
  it("LOADING から始まり、ready で READY、init で INITED、start で RUNNING になる", () => {
    const s0 = initialSession();
    expect(s0.kind).toBe("LOADING");
    const s1 = run(s0, [{ type: "ready", meta }]);
    expect(s1.kind).toBe("READY");
    const s2 = run(s1, [
      { type: "init", sessionId: SID, mode: "play", timeLimit: 300, speed: 1.25 },
    ]);
    expect(s2).toMatchObject({
      kind: "INITED",
      sessionId: SID,
      mode: "play",
      timeLimit: 300,
      speed: 1.25,
    });
    const s3 = run(s2, [{ type: "start" }], 1000);
    expect(s3).toMatchObject({
      kind: "RUNNING",
      sessionId: SID,
      deadlineAt: 1000 + watchdogMs(300, 1.25),
    });
    expect("flagged" in s3).toBe(false);
  });

  it("RUNNING で Guest の end を受理すると ENDED になり、結果は guest 由来の score で scoreable", () => {
    const r = transition(toRunning(), end(120, 42), 2000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toMatchObject({
      kind: "ENDED",
      result: { score: 42, frames: 120, via: "guest", scoreable: true },
    });
    expect(r.effects).toContainEqual({ type: "timer_stop" });
  });

  it("結果に勝敗（outcome / result）や checkpoint は無い（pr#B.2）", () => {
    const s = run(toRunning(), [end(120, 42)], 2000);
    expect(s.kind).toBe("ENDED");
    if (s.kind !== "ENDED") return;
    expect(Object.keys(s.result).sort()).toEqual(["score", "frames", "via", "scoreable"].sort());
  });

  it("start は監視タイマー開始の効果を返す（time_limit ÷ (60 × speed) + 1.5 秒）", () => {
    const r = transition(toInited(), { type: "start" }, 0);
    expect(r.ok && r.effects).toContainEqual({ type: "timer_start", ms: watchdogMs(300, 1) });
    expect(WATCHDOG_GRACE_MS).toBe(1500);
    expect(watchdogMs(300, 1)).toBe(6500);
    expect(watchdogMs(180, 1)).toBe(4500);
  });
});

describe("R-6.4-1 speed で監視タイマーの長さが変わる（pr#A.7, pr#A.8）", () => {
  it("speed 1.0 と 1.5 で長さが違う。600 フレームは 1.0 で 11.5 秒、1.5 で 8.167 秒", () => {
    expect(watchdogMs(600, 1)).toBe(11500);
    expect(watchdogMs(600, 1.5)).toBe(8167);
    expect(watchdogMs(300, 1.5)).toBe(4833);
  });

  it("init の speed が RUNNING の deadline に反映される", () => {
    const s = toRunning(0, 1.5);
    expect(s).toMatchObject({ kind: "RUNNING", speed: 1.5, deadlineAt: watchdogMs(300, 1.5) });
  });

  it("speed は 5 値のどれか。それ以外の init は invalid_speed で拒否", () => {
    expect(SPEEDS).toEqual([1, 1.125, 1.25, 1.375, 1.5]);
    for (const sp of SPEEDS) expect(isSpeed(sp)).toBe(true);
    for (const x of [0.99, 1.1, 1.51, 2, "1", undefined]) expect(isSpeed(x)).toBe(false);
    // 型の外の値（1.1）をわざと入れる。スキーマを通らない値が来ても domain だけで拒否できること
    const bad = { type: "init", sessionId: SID, mode: "play", timeLimit: 300, speed: 1.1 };
    const r = transition(toReady(), bad as unknown as Parameters<typeof transition>[1], 0);
    expect(r).toMatchObject({ ok: false, reason: "invalid_speed" });
  });
});

describe("R-6.4-3 遷移表の網羅: 許されない (状態, イベント) はすべて拒否され、状態は変わらない", () => {
  const fixtures: Record<SessionState["kind"], () => SessionState> = {
    LOADING: () => initialSession(),
    READY: toReady,
    INITED: () => toInited(),
    RUNNING: () => toRunning(),
    PAUSED: () => run(toRunning(), [{ type: "pause" }]),
    ENDED: () => run(toRunning(), [end(1, 0)]),
    DESTROYED: () => run(toRunning(), [{ type: "destroy" }]),
  };
  const sample = (type: (typeof EVENT_TYPES)[number]) => {
    switch (type) {
      case "ready":
        return { type, meta } as const;
      case "init":
        return { type, sessionId: "s2", mode: "play", timeLimit: 300, speed: 1 } as const;
      case "end":
        return end(1);
      case "log":
        return log(0);
      case "error":
        return { type, sessionId: SID, message: "x" } as const;
      default:
        return { type } as const;
    }
  };

  it("イベントの一覧に media は無い（pr#B.1）", () => {
    expect(EVENT_TYPES).not.toContain("media");
    expect(EVENT_TYPES).toHaveLength(10);
  });

  for (const kind of STATE_KINDS) {
    for (const type of EVENT_TYPES) {
      const allowed = ALLOWED[kind].includes(type);
      it(`${kind} × ${type} → ${allowed ? "受理" : "拒否"}`, () => {
        const before = fixtures[kind]();
        // timeout だけは満了後の時刻で評価する（満了前は条件で拒否される。R-6.4-1 で別に検証）
        const now = type === "timeout" ? 1_000_000 : 1;
        const r = transition(before, sample(type), now);
        expect(r.ok).toBe(allowed);
        if (!r.ok) expect(r.state).toBe(before);
      });
    }
  }

  it("ENDED から init で INITED に戻れる（試遊の「もう一回」。R-pr.A5-1）", () => {
    const ended = fixtures.ENDED();
    const r = transition(
      ended,
      { type: "init", sessionId: "s2", mode: "play", timeLimit: 240, speed: 1 },
      0,
    );
    expect(r.ok && r.state).toMatchObject({ kind: "INITED", sessionId: "s2", timeLimit: 240 });
  });

  it("PAUSED からの init は受理しない（R-pr.A5-1）", () => {
    const r = transition(
      fixtures.PAUSED(),
      { type: "init", sessionId: "s2", mode: "play", timeLimit: 240, speed: 1 },
      0,
    );
    expect(r).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("destroy はどの状態からでも DESTROYED に行き、DESTROYED からは何も受理しない", () => {
    for (const kind of STATE_KINDS) {
      const r = transition(fixtures[kind](), { type: "destroy" }, 0);
      if (kind === "DESTROYED") expect(r.ok).toBe(false);
      else expect(r.ok && r.state.kind).toBe("DESTROYED");
    }
  });
});

describe("R-6.1-3 end は 1 セッションに 1 回", () => {
  it("2 回目の end は拒否され、最初の結果が残る", () => {
    const ended = run(toRunning(), [end(10, 7)], 1000);
    const r = transition(ended, end(11, 9), 1001);
    expect(r).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(ended).toMatchObject({ result: { score: 7 } });
  });
});

describe("R-6.4-1 監視タイマー満了と遅れて届く end", () => {
  it("境界: 満了ちょうどの timeout で ENDED。結果は via: timeout だけで、score も frames も持たない（pr#A.7）", () => {
    const running = toRunning(0);
    const r = transition(running, { type: "timeout" }, watchdogMs(300, 1));
    expect(r.ok && r.state.kind === "ENDED" && r.state.result).toEqual({
      via: "timeout",
      scoreable: true,
    });
  });

  it("境界: 満了前の timeout は拒否（タイマーの誤発火）", () => {
    const r = transition(toRunning(0), { type: "timeout" }, watchdogMs(300, 1) - 1);
    expect(r).toMatchObject({ ok: false, reason: "not_expired" });
  });

  it("speed 1.5 では短い時刻で満了する", () => {
    const running = toRunning(0, 1.5);
    expect(transition(running, { type: "timeout" }, watchdogMs(300, 1) - 1).ok).toBe(true);
    expect(transition(running, { type: "timeout" }, watchdogMs(300, 1.5) - 1).ok).toBe(false);
  });

  it("異常: 満了後に届いた end は拒否（P12。Host が先に ENDED(timeout) へ遷移する）", () => {
    const r = transition(toRunning(0), end(300, 99), watchdogMs(300, 1));
    expect(r).toMatchObject({ ok: false, reason: "expired" });
  });

  it("異常: 古い session_id の end は拒否（再 init 後の遅延到着）", () => {
    const ended = run(toRunning(), [end(1, 0)]);
    const again = run(ended, [
      { type: "init", sessionId: "s2", mode: "play", timeLimit: 300, speed: 1 },
      { type: "start" },
    ]);
    const r = transition(again, end(1, 5, SID), 1);
    expect(r).toMatchObject({ ok: false, reason: "stale_session" });
  });

  it("error は RUNNING/PAUSED で ENDED にする。結果は via: error だけで、score も frames も持たない（pr#A.7）", () => {
    const r = transition(toRunning(), { type: "error", sessionId: SID, message: "boom" }, 1);
    expect(r.ok && r.state.kind === "ENDED" && r.state.result).toEqual({
      via: "error",
      scoreable: true,
    });
    const paused = run(toRunning(), [{ type: "pause" }]);
    const r2 = transition(paused, { type: "error", sessionId: SID, message: "boom" }, 1);
    expect(r2.ok && r2.state.kind === "ENDED" && r2.state.result).toEqual({
      via: "error",
      scoreable: true,
    });
  });

  it("P2: replay セッションの end は受理するが scoreable ではない", () => {
    const s = run(toInited("replay"), [{ type: "start" }]);
    const r = transition(s, end(1), 1);
    expect(r.ok && r.state).toMatchObject({ kind: "ENDED", result: { scoreable: false } });
  });
});

describe("R-6.1-5 end.frames は time_limit 以下（pr#A.3, pr#A.8）", () => {
  it("境界: frames = time_limit は受理、+1 は end_frames で捨てる", () => {
    expect(transition(toRunning(), end(300), 5000).ok).toBe(true);
    const before = toRunning();
    const r = transition(before, end(301), 5100);
    expect(r).toMatchObject({ ok: false, reason: "end_frames" });
    expect(r.state).toBe(before);
  });

  it("壁時計で短縮された end（frames < time_limit）は受理する（pr#A.4）", () => {
    const r = transition(toRunning(), end(250, 3), 5000);
    expect(r.ok && r.state).toMatchObject({ kind: "ENDED", result: { frames: 250, score: 3 } });
  });
});

describe("R-6.4-2 PAUSED 中はタイマーが進まない", () => {
  it("pause で残り時間を保存し、resume で残り時間ぶんだけ deadline を先に置く", () => {
    const running = toRunning(0); // deadline = 6500
    const paused = run(running, [{ type: "pause" }], 1000);
    expect(paused).toMatchObject({ kind: "PAUSED", remainingMs: 5500, speed: 1 });
    const resumed = transition(paused, { type: "resume" }, 100000);
    expect(resumed.ok && resumed.state).toMatchObject({ kind: "RUNNING", deadlineAt: 105500 });
    expect(resumed.ok && resumed.effects).toContainEqual({ type: "timer_start", ms: 5500 });
  });

  it("PAUSED 中は timeout を受理しない（時計がいくら進んでも）", () => {
    const paused = run(toRunning(0), [{ type: "pause" }], 1000);
    const r = transition(paused, { type: "timeout" }, 999999);
    expect(r.ok).toBe(false);
  });

  it("P3: PAUSED でも現在セッションの end は受理する（pr#B.5）", () => {
    const paused = run(toRunning(0), [{ type: "pause" }], 1000);
    const r = transition(paused, end(60, 2), 2000);
    expect(r.ok && r.state).toMatchObject({ kind: "ENDED", result: { score: 2, via: "guest" } });
  });
});

describe("R-pr.A9-1 log の from_frame は厳密に増加し、入力は end.frames を超えない。外れた log は捨てるだけ", () => {
  /** 捨てたら理由が log_order で、state は元のまま（参照同一。印を付けない） */
  const dropped = (before: SessionState, e: SessionEvent, now = 2) => {
    const r = transition(before, e, now);
    expect(r).toMatchObject({ ok: false, reason: "log_order" });
    expect(r.state).toBe(before);
  };

  it("典型: 増加する log 列を受理し、最大フレームを覚える", () => {
    const s = run(toRunning(), [log(0, [12, 48]), log(64, [70]), log(128)], 1);
    expect(s).toMatchObject({ kind: "RUNNING", log: { lastFrom: 128, maxFrame: 70 } });
  });

  it("同値の from_frame は捨てる", () => {
    dropped(run(toRunning(), [log(0, [12])], 1), log(0, [20]));
  });

  it("減る from_frame は捨てる", () => {
    dropped(run(toRunning(), [log(64, [70])], 1), log(0, []));
  });

  it("重なる log（from_frame が前の log の最大フレーム以下）は捨てる", () => {
    dropped(run(toRunning(), [log(0, [12, 70])], 1), log(64, [66]));
  });

  it("batch 内で frame が減る入力を含む log は捨てる（sc#A.2 の単調非減少）", () => {
    dropped(toRunning(), log(0, [10, 5]));
    // 同じ frame の連続（同じ tick に 2 入力）は受理する
    expect(transition(toRunning(), log(0, [10, 10, 12]), 1).ok).toBe(true);
  });

  it("from_frame より前の入力を含む log は捨てる", () => {
    dropped(toRunning(), log(64, [63]));
  });

  it("整数でないフレームを含む log は捨てる（スキーマを通らない値が来ても domain だけで捨てる）", () => {
    dropped(toRunning(), log(0.5, [1]));
    dropped(toRunning(), log(0, [1.5]));
    dropped(toRunning(), log(-1, [0]));
  });

  it("log を捨てた後も、end は受け取る。結果に印は無い", () => {
    const s = run(toRunning(0), [log(0, [12])], 1);
    dropped(s, log(0, [20]));
    const r = transition(s, end(100, 7), 2000);
    expect(r.ok && r.state.kind === "ENDED" && r.state.result).toEqual({
      via: "guest",
      score: 7,
      frames: 100,
      scoreable: true,
    });
  });

  it("end.frames より後の入力が log にあれば end を捨てる（end_inputs。状態は変わらない）", () => {
    const s = run(toRunning(), [log(0, [12, 150])], 1);
    const r = transition(s, end(149), 3000);
    expect(r).toMatchObject({ ok: false, reason: "end_inputs" });
    expect(r.state).toBe(s);
    expect(transition(s, end(150), 3000).ok).toBe(true);
  });

  it("PAUSED でも log を受理し、順序を検査する", () => {
    const paused = run(toRunning(), [log(0, [10]), { type: "pause" }], 1);
    const r1 = transition(paused, log(64, [70]), 2);
    expect(r1.ok && r1.state).toMatchObject({
      kind: "PAUSED",
      log: { lastFrom: 64, maxFrame: 70 },
    });
    dropped(paused, log(0));
  });

  it("古い session_id の log は捨てる", () => {
    const before = toRunning();
    const r = transition(before, log(0, [], "old"), 1);
    expect(r).toMatchObject({ ok: false, reason: "stale_session" });
    expect(r.state).toBe(before);
  });

  it("再 init で log の履歴はリセットされる", () => {
    const again = run(
      toRunning(0),
      [
        log(0, [50]),
        end(60),
        { type: "init", sessionId: "s2", mode: "play", timeLimit: 300, speed: 1 },
        { type: "start" },
      ],
      1000,
    );
    expect(again).toMatchObject({ kind: "RUNNING", log: { lastFrom: null, maxFrame: -1 } });
    expect(transition(again, log(0, [], "s2"), 1001).ok).toBe(true);
  });
});

describe("R-sc.A2-2 end を結果の述語で確かめ、満たさないものは値を直さずに捨てる（pr#A.8、sc#A.2）", () => {
  /** 捨てたら state は元のまま（参照同一）で、そのまま満了まで待てる */
  const discarded = (before: SessionState, e: SessionEvent, now: number, reason: string) => {
    const r = transition(before, e, now);
    expect(r).toMatchObject({ ok: false, reason });
    expect(r.state).toBe(before);
  };

  it("score が整数 0〜2^31−1 でなければ捨てる（end_score）。境界は受け取る", () => {
    for (const score of [-1, SCORE_MAX + 1, 1.5, Number.NaN]) {
      discarded(toRunning(), end(60, score), 1000, "end_score");
    }
    for (const score of [0, SCORE_MAX]) {
      const r = transition(toRunning(), end(60, score), 1000);
      expect(r.ok && r.state).toMatchObject({ kind: "ENDED", result: { score } });
    }
  });

  it("frames が整数 0〜time_limit でなければ捨てる（end_frames）", () => {
    for (const frames of [-1, 301, 59.5]) {
      discarded(toRunning(), end(frames), 6000, "end_frames");
    }
  });

  it("frames: 0 は受け取る（開始直後の end。下限 1 は無い）", () => {
    const r = transition(toRunning(0), end(0, 0), 0);
    expect(r.ok && r.state.kind === "ENDED" && r.state.result).toEqual({
      via: "guest",
      score: 0,
      frames: 0,
      scoreable: true,
    });
  });

  it("走っていた時間に対して frames が多すぎれば捨てる（end_realtime）。境界: 走っていた秒 × 1.05 ＋ 0.1", () => {
    // 1000 ms 走った: 1.0 × 1.05 + 0.1 = 1.15 秒 → 69 フレームまで
    expect(transition(toRunning(0), end(69), 1000).ok).toBe(true);
    discarded(toRunning(0), end(70), 1000, "end_realtime");
    // 開始直後に frames = time_limit（SDK を通さない報告）
    discarded(toRunning(0), end(300), 1, "end_realtime");
  });

  it("speed が上がると、同じ時間で申告できる frames が増える", () => {
    // speed 1.5 で 1000 ms: 1.15 秒 × 90 = 103.5 → 103 フレームまで
    expect(transition(toRunning(0, 1.5), end(103), 1000).ok).toBe(true);
    discarded(toRunning(0, 1.5), end(104), 1000, "end_realtime");
  });

  it("捨てた後は状態が変わらず、監視タイマーの満了で終わる。後から届いた正しい end は受け取る", () => {
    const s = toRunning(0);
    discarded(s, end(300, 99), 1, "end_realtime");
    const t = transition(s, { type: "timeout" }, watchdogMs(300, 1));
    expect(t.ok && t.state.kind === "ENDED" && t.state.result).toEqual({
      via: "timeout",
      scoreable: true,
    });
    expect(transition(s, end(300, 5), 5000).ok).toBe(true);
  });

  it("述語は表の上の行から見る（score → frames → 入力ログ → 実時間）", () => {
    const s = run(toRunning(0), [log(0, [200])], 1);
    discarded(s, end(301, -1), 1, "end_score");
    discarded(s, end(301, 1), 1, "end_frames");
    discarded(s, end(150, 1), 1, "end_inputs");
    discarded(s, end(250, 1), 1, "end_realtime");
  });
});

describe("走っていた時間（start から end まで。pause の間を除く。sc#A.2 の 6 行目）", () => {
  it("RUNNING では start からの経過", () => {
    expect(ranMs(toRunning(1000), 1000)).toBe(0);
    expect(ranMs(toRunning(1000), 3500)).toBe(2500);
  });

  it("pause の間は増えず、resume の後にまた増える", () => {
    const paused = run(toRunning(0), [{ type: "pause" }], 1000);
    expect(ranMs(paused, 1000)).toBe(1000);
    expect(ranMs(paused, 60_000)).toBe(1000);
    const resumed = run(paused, [{ type: "resume" }], 60_000);
    expect(ranMs(resumed, 60_000)).toBe(1000);
    expect(ranMs(resumed, 60_700)).toBe(1700);
    const again = run(run(resumed, [{ type: "pause" }], 61_000), [{ type: "resume" }], 99_000);
    expect(ranMs(again, 99_500)).toBe(2500);
  });

  it("pause をはさんだ end は、止まっていた時間を数えない", () => {
    // 1000 ms 走って 59 秒止まり、再開してすぐ: 走っていたのは 1000 ms → 69 フレームまで
    const resumed = run(
      run(toRunning(0), [{ type: "pause" }], 1000),
      [{ type: "resume" }],
      60_000,
    );
    expect(transition(resumed, end(70), 60_000)).toMatchObject({
      ok: false,
      reason: "end_realtime",
    });
    expect(transition(resumed, end(69), 60_000).ok).toBe(true);
    // さらに 1000 ms 走れば 2000 ms ぶん: 2.2 秒 → 132 フレームまで
    expect(transition(resumed, end(132), 61_000).ok).toBe(true);
    expect(transition(resumed, end(133), 61_000).ok).toBe(false);
  });

  it("PAUSED で届いた end は、pause までに走っていた時間で確かめる", () => {
    const paused = run(toRunning(0), [{ type: "pause" }], 1000);
    expect(transition(paused, end(69), 30_000).ok).toBe(true);
    expect(transition(paused, end(70), 30_000)).toMatchObject({
      ok: false,
      reason: "end_realtime",
    });
  });

  it("走っていないとき（INITED、ENDED など）は 0", () => {
    expect(ranMs(toInited(), 5000)).toBe(0);
    expect(ranMs(run(toRunning(0), [end(1)], 1000), 5000)).toBe(0);
  });
});

describe("R-sc.A2-2 性質: 出しうる結果はすべて受理される", () => {
  /** mulberry32。テストの乱数（seed を固定して再現できるようにする） */
  const rng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  it("乱数のイベント列（外れた end / log を含む）を流すと、必ず ENDED になり、結果は述語と Host の実時間の式を満たす", () => {
    const random = rng(166);
    const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
    const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
    const tally = { guest: 0, timeout: 0, error: 0, endDropped: 0, logDropped: 0, paused: 0 };

    for (let trial = 0; trial < 3000; trial++) {
      const speed = pick(SPEEDS);
      const timeLimit = int(180, 600);
      let now = int(0, 10_000);
      let state = run(
        toReady(),
        [{ type: "init", sessionId: SID, mode: "play", timeLimit, speed }, { type: "start" }],
        now,
      );
      // Host ブリッジと同じに、受理した log の入力をつなぐ（packages/sdk/src/host.ts）
      const inputs: [number][] = [];
      // 走っていた時間を、状態機械とは別に数える
      let ran = 0;
      let lastEnd: { score: number; frames: number } | null = null;

      const feed = (e: SessionEvent): boolean => {
        const before = state;
        const r = transition(state, e, now);
        if (!r.ok) expect(r.state).toBe(before);
        state = r.state;
        return r.ok;
      };
      const advance = (ms: number) => {
        // 監視タイマーは満了時刻に鳴る。たまに鳴る前にほかのイベントが先に届く（競合）
        if (state.kind === "RUNNING" && now + ms >= state.deadlineAt && random() < 0.9) {
          ran += state.deadlineAt - now;
          now = state.deadlineAt;
          expect(feed({ type: "timeout" })).toBe(true);
          return;
        }
        if (state.kind === "RUNNING") ran += ms;
        now += ms;
      };

      for (let step = 0; step < 40 && state.kind !== "ENDED"; step++) {
        advance(pick([0, 1, 16, 17, 100, 400, 1500]));
        if (state.kind === "ENDED") break;
        const sessionId = random() < 0.05 ? "old" : SID;
        // SDK が進められるフレーム（実時間以下）と、入力ログの最大フレーム
        const honest = Math.min(timeLimit, Math.floor((ran / 1000) * 60 * speed));
        const maxFrame = inputs.length > 0 ? (inputs[inputs.length - 1] as [number])[0] : -1;
        const roll = random();
        if (roll < 0.35) {
          // log: 続きの位置から始まる正しいものと、でたらめなもの
          const good = random() < 0.6;
          const fromFrame = good ? maxFrame + int(1, 30) : pick([-1, 0, maxFrame, 0.5, int(0, 700)]);
          const inputFrames = Array.from({ length: int(0, 4) }, () =>
            good ? fromFrame : pick([fromFrame - 1, int(0, 700), 2.5]),
          ).map((f, i) => (good ? f + i * int(0, 3) : f));
          if (good) inputFrames.sort((a, b) => a - b);
          if (feed({ type: "log", sessionId, fromFrame, inputFrames })) {
            for (const f of inputFrames) inputs.push([f]);
          } else tally.logDropped++;
        } else if (roll < 0.7) {
          // end: 正直な値、範囲の外、実時間より多い値
          const score = pick([0, 1, int(0, 5000), SCORE_MAX, SCORE_MAX + 1, -1, 0.5]);
          const frames = pick([
            honest,
            honest,
            Math.max(honest, maxFrame),
            0,
            timeLimit,
            timeLimit + 1,
            -1,
            int(0, timeLimit),
            honest + 0.5,
          ]);
          if (feed({ type: "end", sessionId, score, frames })) lastEnd = { score, frames };
          else tally.endDropped++;
        } else if (roll < 0.8) {
          if (feed({ type: "pause" })) tally.paused++;
        } else if (roll < 0.95) {
          feed({ type: "resume" });
        } else if (roll < 0.97) {
          feed({ type: "error", sessionId, message: "boom" });
        } else {
          // 誤発火を含む timeout
          feed({ type: "timeout" });
        }
      }

      // 何も届かなくなっても、再開すれば監視タイマーの満了で終わる
      if (state.kind === "PAUSED") expect(feed({ type: "resume" })).toBe(true);
      if (state.kind === "RUNNING") {
        ran += Math.max(0, state.deadlineAt - now);
        now = Math.max(now, state.deadlineAt);
        expect(feed({ type: "timeout" })).toBe(true);
      }
      expect(state.kind).toBe("ENDED");
      if (state.kind !== "ENDED") return;

      const result = state.result;
      tally[result.via]++;
      if (result.via === "guest") {
        // 値は Guest の報告そのまま（直さない）
        expect({ score: result.score, frames: result.frames }).toEqual(lastEnd);
        const body = { via: "guest", score: result.score, frames: result.frames, inputs };
        expect(readTurnResult(body)).not.toBeNull();
        expect(checkPlayed(body, timeLimit)).toBeNull();
        expect(hostRealtimeOk(result.frames, speed, ran / 1000)).toBe(true);
      } else {
        // 満了と error は値を持たない
        expect(result).toEqual({ via: result.via, scoreable: true });
        expect(readTurnResult({ via: result.via })).toEqual({ via: result.via });
      }
    }

    // 空振りしていないこと: どの終わり方も、捨てた end / log も、pause も十分に出ている
    for (const [name, count] of Object.entries(tally)) {
      expect(count, name).toBeGreaterThan(100);
    }
  });

  it("SDK の式（frame ≤ 走っていた時間 × speed × 60）を満たす end は、満了の前なら捨てない", () => {
    const random = rng(1660);
    const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
    for (let trial = 0; trial < 2000; trial++) {
      const speed = SPEEDS[int(0, SPEEDS.length - 1)] as Speed;
      const timeLimit = int(180, 600);
      let now = int(0, 10_000);
      let state = run(
        toReady(),
        [{ type: "init", sessionId: SID, mode: "play", timeLimit, speed }, { type: "start" }],
        now,
      );
      let ran = 0;
      // pause / resume を 0〜3 回はさむ
      for (let i = int(0, 3); i > 0; i--) {
        const play = int(0, 800);
        ran += play;
        now += play;
        state = run(state, [{ type: "pause" }], now);
        now += int(0, 30_000);
        if (random() < 0.8) state = run(state, [{ type: "resume" }], now);
      }
      if (state.kind === "RUNNING") {
        const play = int(0, Math.max(0, state.deadlineAt - now - 1));
        ran += play;
        now += play;
      }
      const frames = Math.min(timeLimit, Math.floor((ran / 1000) * 60 * speed + 1e-6));
      const r = transition(state, end(frames, int(0, 100)), now);
      expect(r.ok, `speed ${speed} limit ${timeLimit} ran ${ran} frames ${frames}`).toBe(true);
    }
  });
});
