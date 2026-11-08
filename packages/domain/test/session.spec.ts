import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  EVENT_TYPES,
  type GameMeta,
  initialSession,
  MEDIA_MAX_BYTES,
  type SessionState,
  STATE_KINDS,
  transition,
  watchdogMs,
} from "../src/session.ts";

const meta: GameMeta = { title: "押せ", verb: "押せ！", input: "tap", duration: 300, target: 12 };
const SID = "s1";

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
const toInited = (mode: "play" | "replay" = "play") =>
  run(toReady(), [{ type: "init", sessionId: SID, mode, timeLimit: 300 }]);
const toRunning = (now = 0) => run(toInited(), [{ type: "start" }], now);

describe("R-6.4-3 典型: ready → init → start → end", () => {
  it("LOADING から始まり、ready で READY、init で INITED、start で RUNNING になる", () => {
    const s0 = initialSession();
    expect(s0.kind).toBe("LOADING");
    const s1 = run(s0, [{ type: "ready", meta }]);
    expect(s1.kind).toBe("READY");
    const s2 = run(s1, [{ type: "init", sessionId: SID, mode: "play", timeLimit: 300 }]);
    expect(s2).toMatchObject({ kind: "INITED", sessionId: SID, mode: "play", timeLimit: 300 });
    const s3 = run(s2, [{ type: "start" }], 1000);
    expect(s3).toMatchObject({
      kind: "RUNNING",
      sessionId: SID,
      deadlineAt: 1000 + watchdogMs(300),
    });
  });

  it("RUNNING で Guest の end(win) を受理すると ENDED になり、結果は guest 由来で scoreable", () => {
    const r = transition(
      toRunning(),
      { type: "end", sessionId: SID, result: "win", score: 1, frames: 120 },
      500,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toMatchObject({
      kind: "ENDED",
      result: { outcome: "win", score: 1, frames: 120, via: "guest", scoreable: true },
    });
    expect(r.effects).toContainEqual({ type: "timer_stop" });
  });

  it("start は監視タイマー開始の効果を返す（time_limit/60 + 1.5 秒）", () => {
    const r = transition(toInited(), { type: "start" }, 0);
    expect(r.ok && r.effects).toContainEqual({ type: "timer_start", ms: watchdogMs(300) });
    expect(watchdogMs(300)).toBe(6500);
    expect(watchdogMs(180)).toBe(4500);
  });
});

describe("R-6.4-3 遷移表の網羅: 許されない (状態, イベント) はすべて拒否され、状態は変わらない", () => {
  const fixtures: Record<SessionState["kind"], () => SessionState> = {
    LOADING: () => initialSession(),
    READY: toReady,
    INITED: () => toInited(),
    RUNNING: () => toRunning(),
    PAUSED: () => run(toRunning(), [{ type: "pause" }]),
    ENDED: () => run(toRunning(), [{ type: "end", sessionId: SID, result: "lose", frames: 10 }]),
    DESTROYED: () => run(toRunning(), [{ type: "destroy" }]),
  };
  const sample = (type: (typeof EVENT_TYPES)[number]) => {
    switch (type) {
      case "ready":
        return { type, meta } as const;
      case "init":
        return { type, sessionId: "s2", mode: "play", timeLimit: 300 } as const;
      case "end":
        return { type, sessionId: SID, result: "win", frames: 1 } as const;
      case "media":
        return { type, sessionId: SID, kind: "thumb", bytes: 10 } as const;
      case "log":
        return { type, sessionId: SID } as const;
      case "error":
        return { type, sessionId: SID, message: "x" } as const;
      default:
        return { type } as const;
    }
  };

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

  it("ENDED から init で INITED に戻れる（試遊の「もう一回」）", () => {
    const ended = fixtures.ENDED();
    const r = transition(ended, { type: "init", sessionId: "s2", mode: "play", timeLimit: 240 }, 0);
    expect(r.ok && r.state).toMatchObject({ kind: "INITED", sessionId: "s2", timeLimit: 240 });
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
    const ended = run(toRunning(), [{ type: "end", sessionId: SID, result: "win", frames: 10 }]);
    const r = transition(ended, { type: "end", sessionId: SID, result: "lose", frames: 11 }, 1);
    expect(r).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(ended).toMatchObject({ result: { outcome: "win" } });
  });
});

describe("R-6.4-1 監視タイマー満了と遅れて届く end", () => {
  it("境界: 満了ちょうどの timeout で ENDED(lose, via timeout)", () => {
    const running = toRunning(0);
    const r = transition(running, { type: "timeout" }, watchdogMs(300));
    expect(r.ok && r.state).toMatchObject({
      kind: "ENDED",
      result: { outcome: "lose", via: "timeout", scoreable: true },
    });
  });

  it("境界: 満了前の timeout は拒否（タイマーの誤発火）", () => {
    const r = transition(toRunning(0), { type: "timeout" }, watchdogMs(300) - 1);
    expect(r).toMatchObject({ ok: false, reason: "not_expired" });
  });

  it("異常: 満了後に届いた end は拒否（Host が先に ENDED(lose) へ遷移する）", () => {
    const running = toRunning(0);
    const r = transition(
      running,
      { type: "end", sessionId: SID, result: "win", frames: 300 },
      watchdogMs(300),
    );
    expect(r).toMatchObject({ ok: false, reason: "expired" });
  });

  it("異常: 古い session_id の end は拒否（再 init 後の遅延到着）", () => {
    const ended = run(toRunning(), [{ type: "end", sessionId: SID, result: "lose", frames: 1 }]);
    const again = run(ended, [
      { type: "init", sessionId: "s2", mode: "play", timeLimit: 300 },
      { type: "start" },
    ]);
    const r = transition(again, { type: "end", sessionId: SID, result: "win", frames: 1 }, 1);
    expect(r).toMatchObject({ ok: false, reason: "stale_session" });
  });

  it("error は RUNNING/PAUSED で ENDED(lose, via error) にする", () => {
    const r = transition(toRunning(), { type: "error", sessionId: SID, message: "boom" }, 1);
    expect(r.ok && r.state).toMatchObject({
      kind: "ENDED",
      result: { outcome: "lose", via: "error" },
    });
  });

  it("P2: replay セッションの end は受理するが scoreable ではない", () => {
    const s = run(toInited("replay"), [{ type: "start" }]);
    const r = transition(s, { type: "end", sessionId: SID, result: "win", frames: 1 }, 1);
    expect(r.ok && r.state).toMatchObject({ kind: "ENDED", result: { scoreable: false } });
  });
});

describe("R-6.4-2 PAUSED 中はタイマーが進まない", () => {
  it("pause で残り時間を保存し、resume で残り時間ぶんだけ deadline を先に置く", () => {
    const running = toRunning(0); // deadline = 6500
    const paused = run(running, [{ type: "pause" }], 1000);
    expect(paused).toMatchObject({ kind: "PAUSED", remainingMs: 5500 });
    const resumed = transition(paused, { type: "resume" }, 100000);
    expect(resumed.ok && resumed.state).toMatchObject({ kind: "RUNNING", deadlineAt: 105500 });
    expect(resumed.ok && resumed.effects).toContainEqual({ type: "timer_start", ms: 5500 });
  });

  it("PAUSED 中は timeout を受理しない（時計がいくら進んでも）", () => {
    const paused = run(toRunning(0), [{ type: "pause" }], 1000);
    const r = transition(paused, { type: "timeout" }, 999999);
    expect(r.ok).toBe(false);
  });

  it("P3: PAUSED でも現在セッションの end は受理する", () => {
    const paused = run(toRunning(0), [{ type: "pause" }], 1000);
    const r = transition(paused, { type: "end", sessionId: SID, result: "win", frames: 5 }, 2000);
    expect(r.ok && r.state).toMatchObject({
      kind: "ENDED",
      result: { outcome: "win", via: "guest" },
    });
  });
});

describe("R-6.1-4 media は kind ごとに 1 回、サイズ上限", () => {
  it("典型: thumb と video を 1 回ずつ受理する", () => {
    const s = run(
      toRunning(),
      [
        { type: "media", sessionId: SID, kind: "thumb", bytes: 1000 },
        { type: "media", sessionId: SID, kind: "video", bytes: 1_000_000 },
      ],
      1,
    );
    expect(s.kind).toBe("RUNNING");
    expect(s.kind === "RUNNING" && s.media).toEqual({ thumb: true, video: true });
  });

  it("境界: thumb は 64 KiB ちょうどまで、video は 2 MiB ちょうどまで", () => {
    expect(MEDIA_MAX_BYTES).toEqual({ thumb: 65536, video: 2097152 });
    const ok = transition(
      toRunning(),
      { type: "media", sessionId: SID, kind: "thumb", bytes: 65536 },
      1,
    );
    expect(ok.ok).toBe(true);
    const ng = transition(
      toRunning(),
      { type: "media", sessionId: SID, kind: "thumb", bytes: 65537 },
      1,
    );
    expect(ng).toMatchObject({ ok: false, reason: "media_too_large" });
    const ng2 = transition(
      toRunning(),
      { type: "media", sessionId: SID, kind: "video", bytes: 2097153 },
      1,
    );
    expect(ng2).toMatchObject({ ok: false, reason: "media_too_large" });
  });

  it("異常: 同じ kind の 2 回目は拒否", () => {
    const s = run(toRunning(), [{ type: "media", sessionId: SID, kind: "thumb", bytes: 1 }], 1);
    const r = transition(s, { type: "media", sessionId: SID, kind: "thumb", bytes: 1 }, 2);
    expect(r).toMatchObject({ ok: false, reason: "media_duplicate" });
  });

  it("異常: 古い session_id の media は拒否", () => {
    const r = transition(
      toRunning(),
      { type: "media", sessionId: "old", kind: "thumb", bytes: 1 },
      1,
    );
    expect(r).toMatchObject({ ok: false, reason: "stale_session" });
  });
});
