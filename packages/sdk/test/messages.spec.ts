import {
  ACCEPTED_INPUTS,
  DURATION_MAX,
  DURATION_MIN,
  initialSession,
  type SessionEvent,
  SPEEDS,
  transition,
  VERB_MAX_CHARS,
} from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import {
  type GuestToHost,
  type HostToGuest,
  INPUT_LOG_KINDS,
  MESSAGE_TYPES,
  parseGuestMessage,
  parseHostMessage,
  SCORE_MAX,
  SDK_PROTOCOL_VERSION,
  toSessionEvent,
} from "../src/messages.ts";

const SID = "s-01hx";
const ready = {
  type: "ready",
  sdk: "2.0",
  title: "押せ！",
  verb: "押せ！",
  input: "tap",
  duration: 300,
  target: 12,
} as const;
const init = {
  type: "init",
  session_id: SID,
  seed: 2891734521,
  mode: "play",
  time_limit: 300,
  speed: 1,
} as const;
const log = {
  type: "log",
  session_id: SID,
  from_frame: 0,
  inputs: [
    [12, "tap", 0.51, 0.72],
    [30, "hold", 0.5, 0.5, 1],
    [40, "hold", 0.5, 0.5, 0],
    [48, "swipe", 0.2, 0.5, 0.8, 0.5],
    [50, "drag", 0.25, 0.25, 1],
    [60, "drag", 0.5, 0.25, 0],
  ],
} as const;
const end = { type: "end", session_id: SID, score: 42, frames: 180 } as const;
const error = { type: "error", session_id: SID, message: "TypeError: x is undefined" } as const;

const guestOk: Record<string, unknown>[] = [ready, log, end, error];
const hostOk: Record<string, unknown>[] = [
  init,
  { type: "start" },
  { type: "pause" },
  { type: "resume" },
  { type: "destroy" },
];

function expectOk<T>(r: { ok: true; message: T } | { ok: false; reason: string }): T {
  if (!r.ok) throw new Error(`期待: 受理 / 実際: 拒否 (${r.reason})`);
  return r.message;
}
function expectReject(r: { ok: true } | { ok: false; reason: string }, contains?: string): void {
  if (r.ok) throw new Error("期待: 拒否 / 実際: 受理");
  if (contains !== undefined) expect(r.reason).toContain(contains);
}

describe("R-6.1-5 9 種のメッセージをスキーマで検証する（pr#A.3）", () => {
  it("型の一覧は pr#A.3 の 9 種と一致する", () => {
    expect([...MESSAGE_TYPES].sort()).toEqual(
      ["ready", "log", "end", "error", "init", "start", "pause", "resume", "destroy"].sort(),
    );
  });

  it.each(guestOk)("Guest 発の正例が受理される: $type", (m) => {
    const parsed = expectOk(parseGuestMessage(m));
    expect(parsed.type).toBe(m.type);
  });

  it.each(hostOk)("Host 発の正例が受理される: $type", (m) => {
    const parsed = expectOk(parseHostMessage(m));
    expect(parsed.type).toBe(m.type);
  });

  it.each([...guestOk, ...hostOk])("余計なフィールドは拒否される: $type", (m) => {
    const parse = guestOk.includes(m) ? parseGuestMessage : parseHostMessage;
    expectReject(parse({ ...m, extra: 1 }));
  });

  it("型違いは拒否される", () => {
    expectReject(parseGuestMessage({ ...ready, duration: "300" }));
    expectReject(parseGuestMessage({ ...end, frames: "180" }));
    expectReject(parseGuestMessage({ ...end, score: "42" }));
    expectReject(parseHostMessage({ ...init, session_id: 1 }));
    expectReject(parseHostMessage({ ...init, mode: "watch" }));
    expectReject(parseHostMessage({ ...init, time_limit: 1.5 }));
    expectReject(parseHostMessage({ ...init, speed: "1.0" }));
  });

  it("未知の type は拒否される", () => {
    expectReject(parseGuestMessage({ type: "hello" }));
    expectReject(parseHostMessage({ type: "hello" }));
  });

  it("方向が逆のメッセージは拒否される（Host は Guest 発の型しか受けない）", () => {
    for (const m of hostOk) expectReject(parseGuestMessage(m));
    for (const m of guestOk) expectReject(parseHostMessage(m));
  });

  it("オブジェクトでないものは拒否される", () => {
    for (const x of [null, undefined, 1, "ready", [], () => {}]) {
      expectReject(parseGuestMessage(x));
      expectReject(parseHostMessage(x));
    }
  });

  it("必須フィールドの欠落は拒否される", () => {
    const { verb: _v, ...noVerb } = ready;
    expectReject(parseGuestMessage(noVerb));
    const { session_id: _s, ...noSid } = end;
    expectReject(parseGuestMessage(noSid));
    const { seed: _seed, ...noSeed } = init;
    expectReject(parseHostMessage(noSeed));
    const { speed: _sp, ...noSpeed } = init;
    expectReject(parseHostMessage(noSpeed), "speed");
  });
});

describe("R-6.1-4 media は廃止（pr#B.1）", () => {
  it("media は未知の type として拒否される（Blob を載せても載せなくても）", () => {
    expectReject(parseGuestMessage({ type: "media", session_id: SID, kind: "thumb", blob: "x" }));
    expectReject(
      parseGuestMessage({
        type: "media",
        session_id: SID,
        kind: "thumb",
        blob: new Blob([new Uint8Array(10)], { type: "image/png" }),
      }),
    );
    expectReject(parseHostMessage({ type: "media", session_id: SID }));
    expect(MESSAGE_TYPES).not.toContain("media");
  });
});

describe("R-pr.A2-1 ready.sdk はメジャー 2 のみ受理する（pr#A.2）", () => {
  it("現在のバージョンは 2.0", () => {
    expect(SDK_PROTOCOL_VERSION).toBe("2.0");
  });

  it.each([
    ["2.0", true],
    ["2.1", true],
    ["1.1", false],
    ["3.0", false],
    ["2", false],
    ["2.0.1", false],
    ["two", false],
  ])("sdk=%j → 受理=%s", (sdk, ok) => {
    expect(parseGuestMessage({ ...ready, sdk }).ok).toBe(ok);
  });
});

describe("R-6.1-5 ready のメタ制約は静的検査と同じ定数を使う（gc#A.3）", () => {
  it.each([
    [DURATION_MIN - 1, false],
    [DURATION_MIN, true],
    [DURATION_MAX, true],
    [DURATION_MAX + 1, false],
    [300.5, false],
  ])("duration=%s → 受理=%s", (duration, ok) => {
    expect(DURATION_MIN).toBe(180);
    expect(DURATION_MAX).toBe(600);
    expect(parseGuestMessage({ ...ready, duration }).ok).toBe(ok);
  });

  it.each([
    ["", false],
    ["押", true],
    ["あ".repeat(VERB_MAX_CHARS), true],
    ["あ".repeat(VERB_MAX_CHARS + 1), false],
    // 書記素クラスタで数える。ZWJ 絵文字 1 つは 1 文字
    [`${"👨‍👩‍👧‍👦".repeat(VERB_MAX_CHARS)}`, true],
    [`${"👨‍👩‍👧‍👦".repeat(VERB_MAX_CHARS + 1)}`, false],
  ])("verb=%j → 受理=%s", (verb, ok) => {
    expect(parseGuestMessage({ ...ready, verb }).ok).toBe(ok);
  });

  const inputCases: [string, boolean][] = [
    ...ACCEPTED_INPUTS.map((i): [string, boolean] => [i, true]),
    ["tilt", false],
    ["mouse", false],
  ];
  it.each(inputCases)("input=%s → 受理=%s", (input, ok) => {
    expect(parseGuestMessage({ ...ready, input }).ok).toBe(ok);
  });

  it("drag と stick は gf:input として受理される（gc#A.4）", () => {
    expect(ACCEPTED_INPUTS).toContain("drag");
    expect(ACCEPTED_INPUTS).toContain("stick");
  });

  it.each([
    [1, true],
    [12, true],
    [0, false],
    [-1, false],
    [1.5, false],
    ["12", false],
  ])("target=%j → 受理=%s", (target, ok) => {
    expect(parseGuestMessage({ ...ready, target }).ok).toBe(ok);
  });

  it("target の欠落は拒否する", () => {
    const { target: _t, ...noTarget } = ready;
    expectReject(parseGuestMessage(noTarget));
  });

  it("title は空白のみを拒否する", () => {
    expectReject(parseGuestMessage({ ...ready, title: "   " }));
  });
});

describe("R-6.1-5 init（pr#A.3, pr#A.8）", () => {
  it("replay では inputs が必須", () => {
    expectReject(parseHostMessage({ ...init, mode: "replay" }), "inputs");
    expectOk(parseHostMessage({ ...init, mode: "replay", inputs: [[12, "tap", 0.5, 0.5]] }));
    expectOk(parseHostMessage({ ...init, mode: "replay", inputs: [] }));
  });

  it("record は無い（media 廃止に伴い余計なキー）", () => {
    expectReject(parseHostMessage({ ...init, mode: "replay", inputs: [], record: true }));
  });

  it.each([
    [0.99, false],
    [1.0, true],
    [1.1, false],
    [1.125, true],
    [1.25, true],
    [1.375, true],
    [1.5, true],
    [1.51, false],
    [2, false],
  ])("speed=%s → 受理=%s（1.0〜1.5 の 1/8 刻み）", (speed, ok) => {
    expect(parseHostMessage({ ...init, speed }).ok).toBe(ok);
  });

  it("speed の候補は domain の SPEEDS と同じ 5 値", () => {
    expect(SPEEDS).toHaveLength(5);
    for (const speed of SPEEDS) expectOk(parseHostMessage({ ...init, speed }));
  });

  it("seed は 0 以上の整数、time_limit は 1 以上の整数", () => {
    expectReject(parseHostMessage({ ...init, seed: -1 }));
    expectReject(parseHostMessage({ ...init, seed: 1.5 }));
    expectOk(parseHostMessage({ ...init, seed: 0 }));
    expectReject(parseHostMessage({ ...init, time_limit: 0 }));
    expectOk(parseHostMessage({ ...init, time_limit: 1 }));
  });

  it("session_id は空文字を拒否する", () => {
    expectReject(parseHostMessage({ ...init, session_id: "" }));
  });
});

describe("R-6.1-5 log の入力ログ形式（pr#A.3）", () => {
  it("kind は tap / hold / swipe / drag の 4 種。key と tilt は拒否", () => {
    expect([...INPUT_LOG_KINDS].sort()).toEqual(["drag", "hold", "swipe", "tap"]);
    expectReject(parseGuestMessage({ ...log, inputs: [[12, "key", "ArrowLeft", 1]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[12, "tilt", 0.1, 0.2]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[12, "stick", 0.1, 0.2]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[12, "mouse", 0, 0]] }));
  });

  it("要素は [frame, kind, ...data] のフラットな配列。frame は 0 以上の整数", () => {
    expectReject(parseGuestMessage({ ...log, inputs: [[-1, "tap", 0, 0]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1.5, "tap", 0, 0]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [["12", "tap", 0, 0]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[12]] }));
    expectReject(parseGuestMessage({ ...log, inputs: "none" }));
    // 旧形式（data を配列で入れ子）は拒否
    expectReject(parseGuestMessage({ ...log, inputs: [[12, "tap", [0.5, 0.5]]] }));
    expectOk(parseGuestMessage({ ...log, inputs: [] }));
  });

  it("kind ごとの長さ: tap 4、hold / drag 5（末尾は 0 か 1）、swipe 6", () => {
    expectOk(parseGuestMessage({ ...log, inputs: [[1, "tap", 0, 1]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "tap", 0]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "tap", 0, 1, 1]] }));
    expectOk(parseGuestMessage({ ...log, inputs: [[1, "hold", 0.5, 0.5, 1]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "hold", 0.5, 0.5]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "hold", 0.5, 0.5, 2]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "hold", 0.5, 0.5, true]] }));
    expectOk(parseGuestMessage({ ...log, inputs: [[1, "drag", 0.5, 0.5, 0]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "drag", 0.5, 0.5]] }));
    expectOk(parseGuestMessage({ ...log, inputs: [[1, "swipe", 0, 0, 1, 1]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "swipe", 0, 0, 1]] }));
  });

  it("座標は 0〜1 の正規化値", () => {
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "tap", -0.01, 0.5]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "tap", 0.5, 1.01]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1, "tap", "0.5", 0.5]] }));
  });

  it("from_frame は 0 以上の整数", () => {
    expectReject(parseGuestMessage({ ...log, from_frame: -1 }));
    expectReject(parseGuestMessage({ ...log, from_frame: 0.5 }));
  });
});

describe("R-6.1-5 end（pr#A.3、pr#B.2: result と checkpoint は無い）", () => {
  it.each([
    [0, true],
    [SCORE_MAX, true],
    [SCORE_MAX + 1, false],
    [-1, false],
    [1.5, false],
  ])("score=%s → 受理=%s（0 ≤ score ≤ 2^31−1）", (score, ok) => {
    expect(parseGuestMessage({ ...end, score }).ok).toBe(ok);
  });

  it("score は必須", () => {
    const { score: _s, ...noScore } = end;
    expectReject(parseGuestMessage(noScore), "score");
  });

  it("result（勝敗）や checkpoint があれば拒否", () => {
    expectReject(parseGuestMessage({ ...end, result: "win" }));
    expectReject(parseGuestMessage({ ...end, result: "lose" }));
    expectReject(parseGuestMessage({ ...end, checkpoint: "a91f" }));
  });

  it("frames は 0 以上の整数（time_limit 以下かは状態機械が検査する）", () => {
    expectReject(parseGuestMessage({ ...end, frames: -1 }));
    expectReject(parseGuestMessage({ ...end, frames: 1.5 }));
    expectOk(parseGuestMessage({ ...end, frames: 0 }));
    expectOk(parseGuestMessage({ ...end, frames: 100000 }));
  });
});

describe("R-6.1-5 Guest メッセージは domain の SessionEvent に 1 対 1 で対応する（pr#A.5）", () => {
  it("すべての Guest 発メッセージが SessionEvent に変換でき、状態機械が受理する", () => {
    const now = 1000;
    let state = initialSession();
    const step = (m: GuestToHost | HostToGuest) => {
      const ev: SessionEvent = toSessionEvent(m);
      const r = transition(state, ev, now);
      if (!r.ok) throw new Error(`${ev.type} が拒否された: ${r.reason}`);
      state = r.state;
      return ev;
    };
    const readyEv = step(expectOk(parseGuestMessage(ready)));
    expect(readyEv).toEqual({
      type: "ready",
      meta: { title: "押せ！", verb: "押せ！", input: "tap", duration: 300, target: 12 },
    });
    const initEv = step(expectOk(parseHostMessage({ ...init, speed: 1.25 })));
    expect(initEv).toEqual({
      type: "init",
      sessionId: SID,
      mode: "play",
      timeLimit: 300,
      speed: 1.25,
    });
    step(expectOk(parseHostMessage({ type: "start" })));
    expect(step(expectOk(parseGuestMessage(log)))).toEqual({
      type: "log",
      sessionId: SID,
      fromFrame: 0,
      inputFrames: [12, 30, 40, 48, 50, 60],
    });
    expect(step(expectOk(parseHostMessage({ type: "pause" })))).toEqual({ type: "pause" });
    expect(step(expectOk(parseHostMessage({ type: "resume" })))).toEqual({ type: "resume" });
    const endEv = step(expectOk(parseGuestMessage(end)));
    expect(endEv).toEqual({ type: "end", sessionId: SID, score: 42, frames: 180 });
    expect(state).toMatchObject({
      kind: "ENDED",
      result: { score: 42, frames: 180, via: "guest", scoreable: true, flagged: false },
    });
    expect(step(expectOk(parseHostMessage({ type: "destroy" })))).toEqual({ type: "destroy" });
    expect(state.kind).toBe("DESTROYED");
  });

  it("end.frames > time_limit は状態機械が拒否する（R-6.1-5、pr#A.8）", () => {
    let state = initialSession();
    for (const m of [ready, init, { type: "start" }] as const) {
      const r = transition(
        state,
        toSessionEvent(
          m.type === "ready" ? expectOk(parseGuestMessage(m)) : expectOk(parseHostMessage(m)),
        ),
        0,
      );
      if (!r.ok) throw new Error(r.reason);
      state = r.state;
    }
    const over = toSessionEvent(expectOk(parseGuestMessage({ ...end, frames: 301 })));
    expect(transition(state, over, 1)).toMatchObject({ ok: false, reason: "frames_over_limit" });
  });

  it("error は message を持つ SessionEvent になる", () => {
    expect(toSessionEvent(expectOk(parseGuestMessage(error)))).toEqual({
      type: "error",
      sessionId: SID,
      message: "TypeError: x is undefined",
    });
  });
});
