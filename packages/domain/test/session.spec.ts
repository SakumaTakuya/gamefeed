import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  EVENT_TYPES,
  type GameMeta,
  initialSession,
  isSpeed,
  type SessionState,
  SPEEDS,
  type Speed,
  STATE_KINDS,
  transition,
  WATCHDOG_GRACE_MS,
  watchdogMs,
} from "../src/session.ts";

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
      flagged: false,
    });
  });

  it("RUNNING で Guest の end を受理すると ENDED になり、結果は guest 由来の score で scoreable", () => {
    const r = transition(toRunning(), end(120, 42), 500);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toMatchObject({
      kind: "ENDED",
      result: { score: 42, frames: 120, via: "guest", scoreable: true, flagged: false },
    });
    expect(r.effects).toContainEqual({ type: "timer_stop" });
  });

  it("結果に勝敗（outcome / result）や checkpoint は無い（pr#B.2）", () => {
    const s = run(toRunning(), [end(120, 42)], 500);
    expect(s.kind).toBe("ENDED");
    if (s.kind !== "ENDED") return;
    expect(Object.keys(s.result).sort()).toEqual(
      ["score", "frames", "via", "scoreable", "flagged"].sort(),
    );
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
    ENDED: () => run(toRunning(), [end(10, 0)]),
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
    const ended = run(toRunning(), [end(10, 7)]);
    const r = transition(ended, end(11, 9), 1);
    expect(r).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(ended).toMatchObject({ result: { score: 7 } });
  });
});

describe("R-6.4-1 監視タイマー満了と遅れて届く end", () => {
  it("境界: 満了ちょうどの timeout で ENDED(via timeout, score 0, frames time_limit)", () => {
    const running = toRunning(0);
    const r = transition(running, { type: "timeout" }, watchdogMs(300, 1));
    expect(r.ok && r.state).toMatchObject({
      kind: "ENDED",
      result: { score: 0, frames: 300, via: "timeout", scoreable: true },
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

  it("error は RUNNING/PAUSED で ENDED(via error, score 0) にする。frames は持たない", () => {
    const r = transition(toRunning(), { type: "error", sessionId: SID, message: "boom" }, 1);
    expect(r.ok && r.state).toMatchObject({
      kind: "ENDED",
      result: { score: 0, via: "error", scoreable: true },
    });
    expect(r.ok && r.state.kind === "ENDED" && "frames" in r.state.result).toBe(false);
    const paused = run(toRunning(), [{ type: "pause" }]);
    const r2 = transition(paused, { type: "error", sessionId: SID, message: "boom" }, 1);
    expect(r2.ok && r2.state).toMatchObject({ kind: "ENDED", result: { via: "error", score: 0 } });
  });

  it("P2: replay セッションの end は受理するが scoreable ではない", () => {
    const s = run(toInited("replay"), [{ type: "start" }]);
    const r = transition(s, end(1), 1);
    expect(r.ok && r.state).toMatchObject({ kind: "ENDED", result: { scoreable: false } });
  });
});

describe("R-6.1-5 end.frames は time_limit 以下（pr#A.3, pr#A.8）", () => {
  it("境界: frames = time_limit は受理、+1 は frames_over_limit で拒否", () => {
    expect(transition(toRunning(), end(300), 1).ok).toBe(true);
    const r = transition(toRunning(), end(301), 1);
    expect(r).toMatchObject({ ok: false, reason: "frames_over_limit" });
  });

  it("壁時計で短縮された end（frames < time_limit）は受理する（pr#A.4）", () => {
    const r = transition(toRunning(), end(250, 3), 1);
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
    const r = transition(paused, end(5, 2), 2000);
    expect(r.ok && r.state).toMatchObject({ kind: "ENDED", result: { score: 2, via: "guest" } });
  });
});

describe("R-pr.A9-1 log の from_frame は厳密に増加し、入力は end.frames を超えない", () => {
  it("典型: 増加する log 列を受理し、最大フレームを覚える", () => {
    const s = run(toRunning(), [log(0, [12, 48]), log(64, [70]), log(128)], 1);
    expect(s).toMatchObject({
      kind: "RUNNING",
      log: { lastFrom: 128, maxFrame: 70 },
      flagged: false,
    });
  });

  it("同値の from_frame は捨てて flagged にする（イベントは拒否、state だけ flagged が立つ）", () => {
    const s = run(toRunning(), [log(0, [12])], 1);
    const r = transition(s, log(0, [20]), 2);
    expect(r).toMatchObject({ ok: false, reason: "flagged_log_order" });
    expect(r.state).toMatchObject({
      kind: "RUNNING",
      flagged: true,
      log: { lastFrom: 0, maxFrame: 12 },
    });
  });

  it("減る from_frame は捨てて flagged にする", () => {
    const s = run(toRunning(), [log(64, [70])], 1);
    const r = transition(s, log(0, []), 2);
    expect(r).toMatchObject({ ok: false, reason: "flagged_log_order" });
    expect(r.state).toMatchObject({ flagged: true });
  });

  it("重なる log（from_frame が前の log の最大フレーム以下）も捨てて flagged にする", () => {
    const s = run(toRunning(), [log(0, [12, 70])], 1);
    const r = transition(s, log(64, [66]), 2);
    expect(r).toMatchObject({ ok: false, reason: "flagged_log_order" });
  });

  it("from_frame より前の入力を含む log は捨てて flagged にする", () => {
    const r = transition(toRunning(), log(64, [63]), 1);
    expect(r).toMatchObject({ ok: false, reason: "flagged_log_order" });
  });

  it("flagged は結果に残る（end / timeout / error）", () => {
    const flagged = transition(run(toRunning(0), [log(0)], 1), log(0), 2).state;
    const viaEnd = transition(flagged, end(100), 3);
    expect(viaEnd.ok && viaEnd.state).toMatchObject({ result: { via: "guest", flagged: true } });
    const viaTimeout = transition(flagged, { type: "timeout" }, 1_000_000);
    expect(viaTimeout.ok && viaTimeout.state).toMatchObject({
      result: { via: "timeout", flagged: true },
    });
    const viaError = transition(flagged, { type: "error", sessionId: SID, message: "x" }, 3);
    expect(viaError.ok && viaError.state).toMatchObject({
      result: { via: "error", flagged: true },
    });
  });

  it("end.frames より後の入力が log にあれば end を捨てて flagged にする", () => {
    const s = run(toRunning(), [log(0, [12, 150])], 1);
    const r = transition(s, end(149), 2);
    expect(r).toMatchObject({ ok: false, reason: "flagged_log_over_frames" });
    expect(r.state).toMatchObject({ kind: "RUNNING", flagged: true });
    expect(transition(s, end(150), 2).ok).toBe(true);
  });

  it("PAUSED でも log を受理し、順序を検査する", () => {
    const paused = run(toRunning(), [log(0, [10]), { type: "pause" }], 1);
    const r1 = transition(paused, log(64, [70]), 2);
    expect(r1.ok && r1.state).toMatchObject({
      kind: "PAUSED",
      log: { lastFrom: 64, maxFrame: 70 },
    });
    expect(transition(paused, log(0), 2)).toMatchObject({ ok: false, reason: "flagged_log_order" });
  });

  it("古い session_id の log は捨てるが flagged にはしない", () => {
    const r = transition(toRunning(), log(0, [], "old"), 1);
    expect(r).toMatchObject({ ok: false, reason: "stale_session" });
    expect(r.state).toMatchObject({ flagged: false });
  });

  it("再 init で log の履歴と flagged はリセットされる", () => {
    const flagged = transition(run(toRunning(0), [log(0)], 1), log(0), 2).state;
    const again = run(flagged, [
      end(10),
      { type: "init", sessionId: "s2", mode: "play", timeLimit: 300, speed: 1 },
      { type: "start" },
    ]);
    expect(again).toMatchObject({ kind: "RUNNING", flagged: false, log: { lastFrom: null } });
    expect(transition(again, log(0, [], "s2"), 1).ok).toBe(true);
  });
});
