import {
  ACCEPTED_INPUTS,
  DURATION_MAX,
  DURATION_MIN,
  MEDIA_MAX_BYTES,
  type SessionEvent,
  VERB_MAX_CHARS,
  initialSession,
  transition,
} from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import {
  type GuestToHost,
  type HostToGuest,
  MESSAGE_TYPES,
  SCORE_MAX,
  parseGuestMessage,
  parseHostMessage,
  toSessionEvent,
} from "../src/messages.ts";

const SID = "s-01hx";
const ready = {
  type: "ready",
  sdk: "1.1",
  title: "押せ！",
  verb: "押せ！",
  input: "tap",
  duration: 300,
} as const;
const init = {
  type: "init",
  session_id: SID,
  seed: 2891734521,
  mode: "play",
  time_limit: 300,
} as const;
const log = {
  type: "log",
  session_id: SID,
  from_frame: 0,
  inputs: [
    [12, "tap", [0.51, 0.72]],
    [48, "swipe", [0.2, 0.5, 0.8, 0.5]],
    [120, "key", "ArrowLeft", 1],
  ],
} as const;
const end = { type: "end", session_id: SID, result: "win", frames: 180 } as const;
const png = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: "image/png" });
const webm = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: "video/webm" });
const media = { type: "media", session_id: SID, kind: "thumb", blob: png(1024) } as const;
const error = { type: "error", session_id: SID, message: "TypeError: x is undefined" } as const;

const guestOk: Record<string, unknown>[] = [ready, log, end, media, error];
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

describe("R-6.1-5 10 種のメッセージをスキーマで検証する", () => {
  it("型の一覧は spec#6.1 の 10 種と一致する", () => {
    expect([...MESSAGE_TYPES].sort()).toEqual(
      ["ready", "init", "start", "pause", "resume", "log", "end", "media", "error", "destroy"].sort(),
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
    expectReject(parseGuestMessage({ ...end, result: "draw" }));
    expectReject(parseGuestMessage({ ...media, blob: "data:image/png;base64,AAAA" }));
    expectReject(parseHostMessage({ ...init, session_id: 1 }));
    expectReject(parseHostMessage({ ...init, mode: "watch" }));
    expectReject(parseHostMessage({ ...init, time_limit: 1.5 }));
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
  });
});

describe("R-6.1-5 ready のメタ制約は静的解析と同じ定数を使う（spec#6.3）", () => {
  it.each([
    [DURATION_MIN - 1, false],
    [DURATION_MIN, true],
    [DURATION_MAX, true],
    [DURATION_MAX + 1, false],
    [300.5, false],
  ])("duration=%s → 受理=%s", (duration, ok) => {
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

  it.each([...ACCEPTED_INPUTS.map((i) => [i, true] as const), ["tilt", false], ["mouse", false]])(
    "input=%s → 受理=%s",
    (input, ok) => {
      expect(parseGuestMessage({ ...ready, input }).ok).toBe(ok);
    },
  );

  it("sdk は 1.1 固定", () => {
    expectReject(parseGuestMessage({ ...ready, sdk: "1.0" }));
  });

  it("title は空白のみを拒否する", () => {
    expectReject(parseGuestMessage({ ...ready, title: "   " }));
  });
});

describe("R-6.1-5 init（spec#6.1, spec#7.4）", () => {
  it("replay では inputs が必須", () => {
    expectReject(parseHostMessage({ ...init, mode: "replay" }), "inputs");
    expectOk(parseHostMessage({ ...init, mode: "replay", inputs: [[12, "tap", [0.5, 0.5]]] }));
    expectOk(parseHostMessage({ ...init, mode: "replay", inputs: [] }));
  });

  it("record は boolean", () => {
    expectOk(parseHostMessage({ ...init, mode: "replay", inputs: [], record: true }));
    expectReject(parseHostMessage({ ...init, record: "yes" }));
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

describe("R-6.1-5 log の入力ログ形式（spec#7.1）", () => {
  it("[frame, kind, ...data] の配列。frame は 0 以上の整数、kind は既知の種別", () => {
    expectReject(parseGuestMessage({ ...log, inputs: [[-1, "tap", [0, 0]]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[1.5, "tap", [0, 0]]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [["12", "tap", [0, 0]]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[12, "mouse", [0, 0]]] }));
    expectReject(parseGuestMessage({ ...log, inputs: [[12]] }));
    expectReject(parseGuestMessage({ ...log, inputs: "none" }));
    expectOk(parseGuestMessage({ ...log, inputs: [] }));
  });

  it("from_frame は 0 以上の整数", () => {
    expectReject(parseGuestMessage({ ...log, from_frame: -1 }));
  });
});

describe("R-6.1-5 end のスコア（spec#10.4: 0 ≤ score ≤ 2^31−1）", () => {
  it.each([
    [0, true],
    [SCORE_MAX, true],
    [SCORE_MAX + 1, false],
    [-1, false],
    [1.5, false],
  ])("score=%s → 受理=%s", (score, ok) => {
    expect(parseGuestMessage({ ...end, score }).ok).toBe(ok);
  });

  it("checkpoint は文字列、frames は 0 以上の整数", () => {
    expectOk(parseGuestMessage({ ...end, checkpoint: "a91f" }));
    expectReject(parseGuestMessage({ ...end, checkpoint: 1 }));
    expectReject(parseGuestMessage({ ...end, frames: -1 }));
  });
});

describe("R-6.1-5 media のサイズ上限と形式（spec#6.1, R-6.1-4）", () => {
  it("thumb は PNG ≤ 64 KB", () => {
    expectOk(parseGuestMessage({ ...media, blob: png(MEDIA_MAX_BYTES.thumb) }));
    expectReject(parseGuestMessage({ ...media, blob: png(MEDIA_MAX_BYTES.thumb + 1) }), "64");
    expectReject(parseGuestMessage({ ...media, blob: webm(100) }));
  });

  it("video は WebM ≤ 2 MB", () => {
    expectOk(parseGuestMessage({ ...media, kind: "video", blob: webm(MEDIA_MAX_BYTES.video) }));
    expectReject(parseGuestMessage({
      ...media,
      kind: "video",
      blob: webm(MEDIA_MAX_BYTES.video + 1),
    }));
    expectReject(parseGuestMessage({ ...media, kind: "video", blob: png(100) }));
    // MediaRecorder は codecs 付きの MIME を返すことがある
    expectOk(parseGuestMessage({
      ...media,
      kind: "video",
      blob: new Blob([new Uint8Array(10)], { type: "video/webm;codecs=vp8" }),
    }));
  });

  it("kind は thumb / video のみ", () => {
    expectReject(parseGuestMessage({ ...media, kind: "gif" }));
  });
});

describe("R-6.1-5 Guest メッセージは domain の SessionEvent に 1 対 1 で対応する（spec#6.4）", () => {
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
      meta: { title: "押せ！", verb: "押せ！", input: "tap", duration: 300 },
    });
    const initEv = step(expectOk(parseHostMessage(init)));
    expect(initEv).toEqual({ type: "init", sessionId: SID, mode: "play", timeLimit: 300 });
    step(expectOk(parseHostMessage({ type: "start" })));
    expect(step(expectOk(parseGuestMessage(log)))).toEqual({ type: "log", sessionId: SID });
    expect(step(expectOk(parseGuestMessage(media)))).toEqual({
      type: "media",
      sessionId: SID,
      kind: "thumb",
      bytes: 1024,
    });
    expect(step(expectOk(parseHostMessage({ type: "pause" })))).toEqual({ type: "pause" });
    expect(step(expectOk(parseHostMessage({ type: "resume" })))).toEqual({ type: "resume" });
    const endEv = step(expectOk(parseGuestMessage({ ...end, score: 42, checkpoint: "c" })));
    expect(endEv).toEqual({
      type: "end",
      sessionId: SID,
      result: "win",
      score: 42,
      frames: 180,
      checkpoint: "c",
    });
    expect(state.kind).toBe("ENDED");
    expect(step(expectOk(parseHostMessage({ type: "destroy" })))).toEqual({ type: "destroy" });
    expect(state.kind).toBe("DESTROYED");
  });

  it("end の任意項目は無ければキーごと落とす（undefined を残さない）", () => {
    const ev = toSessionEvent(expectOk(parseGuestMessage(end)));
    expect(Object.keys(ev)).toEqual(["type", "sessionId", "result", "frames"]);
  });

  it("error は message を持つ SessionEvent になる", () => {
    expect(toSessionEvent(expectOk(parseGuestMessage(error)))).toEqual({
      type: "error",
      sessionId: SID,
      message: "TypeError: x is undefined",
    });
  });
});
