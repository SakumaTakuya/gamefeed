/**
 * Host↔Guest メッセージスキーマ（spec#6.1）。
 *
 * 10 種のメッセージを valibot で定義し、Host と Guest の両側で同じ検証を使う。
 * 違反は呼び出し側（Host ブリッジ / Guest SDK）が即セッション破棄にする（spec#6）。
 *
 * ワイヤ形式は `{type, ...payload}` のフラットな JSON。キーは spec#6.1 どおり snake_case。
 * domain の `SessionEvent`（camelCase）への変換は `toSessionEvent` が担う。
 *
 * zod ではなく valibot を使う理由: SDK は全ゲームの <head> に注入されるため（spec#4.4）、
 * バンドルサイズが効く。同じスキーマで valibot ≈ 2.4 KB gz、zod/mini ≈ 8.5 KB gz、zod ≈ 54 KB gz（#7）。
 */

import {
  ACCEPTED_INPUTS,
  DURATION_MAX,
  DURATION_MIN,
  graphemeCount,
  type InputKind,
  MEDIA_MAX_BYTES,
  type MediaKind,
  type Mode,
  type Outcome,
  type SessionEvent,
  VERB_MAX_CHARS,
} from "@gamefeed/domain";
import * as v from "valibot";

export const SDK_PROTOCOL_VERSION = "1.1";

/** spec#10.4: 0 ≤ score ≤ 2^31−1 */
export const SCORE_MAX = 2 ** 31 - 1;

/** 入力ログの種別（spec#6.2 の onInput 4 種 ＋ spec#7.1 の key） */
export const INPUT_LOG_KINDS = ["tap", "hold", "swipe", "tilt", "key"] as const;

export const MESSAGE_TYPES = [
  "ready",
  "init",
  "start",
  "pause",
  "resume",
  "log",
  "end",
  "media",
  "error",
  "destroy",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

// ---- 部品 ----------------------------------------------------------------

const nonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0));
const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const sessionId = v.pipe(v.string(), v.nonEmpty("session_id が空です"));

/** `[frame, kind, ...data]`（spec#7.1）。data は JSON 値ならなんでもよい */
const inputLogEntry = v.tupleWithRest([nonNegativeInt, v.picklist(INPUT_LOG_KINDS)], v.unknown());
export type InputLogEntry = v.InferOutput<typeof inputLogEntry>;

const verb = v.pipe(
  v.string(),
  v.check((s) => {
    const n = graphemeCount(s);
    return n >= 1 && n <= VERB_MAX_CHARS;
  }, `verb は 1〜${VERB_MAX_CHARS} 文字`),
);

const duration = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(DURATION_MIN),
  v.maxValue(DURATION_MAX),
);

const mediaBlob = v.pipe(
  v.instance(Blob),
  v.check((b) => b.size > 0, "blob が空です"),
);

// ---- Guest → Host --------------------------------------------------------

const ready = v.strictObject({
  type: v.literal("ready"),
  sdk: v.literal(SDK_PROTOCOL_VERSION),
  title: v.pipe(v.string(), v.trim(), v.nonEmpty("title が空です")),
  verb,
  input: v.picklist(ACCEPTED_INPUTS as readonly InputKind[]),
  duration,
});

const log = v.strictObject({
  type: v.literal("log"),
  session_id: sessionId,
  from_frame: nonNegativeInt,
  inputs: v.array(inputLogEntry),
});

const end = v.strictObject({
  type: v.literal("end"),
  session_id: sessionId,
  result: v.picklist(["win", "lose"] satisfies readonly Outcome[]),
  score: v.optional(v.pipe(nonNegativeInt, v.maxValue(SCORE_MAX))),
  frames: nonNegativeInt,
  checkpoint: v.optional(v.string()),
});

const MEDIA_MIME: Record<MediaKind, (mime: string) => boolean> = {
  thumb: (m) => m === "image/png",
  video: (m) => m === "video/webm" || m.startsWith("video/webm;"),
};

const media = v.pipe(
  v.strictObject({
    type: v.literal("media"),
    session_id: sessionId,
    kind: v.picklist(["thumb", "video"] satisfies readonly MediaKind[]),
    blob: mediaBlob,
  }),
  v.check(
    (m) => m.blob.size <= MEDIA_MAX_BYTES[m.kind],
    (i) => {
      const kb = MEDIA_MAX_BYTES[i.input.kind] / 1024;
      return `${i.input.kind} は ${kb} KB まで（${i.input.blob.size} バイト）`;
    },
  ),
  v.check((m) => MEDIA_MIME[m.kind](m.blob.type), "thumb は image/png、video は video/webm"),
);

const error = v.strictObject({
  type: v.literal("error"),
  session_id: sessionId,
  message: v.string(),
});

export const GuestToHostSchema = v.variant("type", [ready, log, end, media, error]);
export type GuestToHost = v.InferOutput<typeof GuestToHostSchema>;

// ---- Host → Guest --------------------------------------------------------

const init = v.pipe(
  v.strictObject({
    type: v.literal("init"),
    session_id: sessionId,
    seed: nonNegativeInt,
    mode: v.picklist(["play", "replay"] satisfies readonly Mode[]),
    time_limit: positiveInt,
    inputs: v.optional(v.array(inputLogEntry)),
    record: v.optional(v.boolean()),
  }),
  v.check((m) => m.mode !== "replay" || m.inputs !== undefined, "replay では inputs が必須"),
);

const empty = <T extends MessageType>(type: T) => v.strictObject({ type: v.literal(type) });

export const HostToGuestSchema = v.variant("type", [
  init,
  empty("start"),
  empty("pause"),
  empty("resume"),
  empty("destroy"),
]);
export type HostToGuest = v.InferOutput<typeof HostToGuestSchema>;

export type Message = GuestToHost | HostToGuest;

// ---- 検証 ------------------------------------------------------------------

export type ParseResult<T> = { ok: true; message: T } | { ok: false; reason: string };

function parse<S extends v.GenericSchema>(schema: S, raw: unknown): ParseResult<v.InferOutput<S>> {
  const r = v.safeParse(schema, raw);
  if (r.success) return { ok: true, message: r.output };
  const first = r.issues[0];
  const path = first.path?.map((p) => String(p.key)).join(".") ?? "";
  return { ok: false, reason: path ? `${path}: ${first.message}` : first.message };
}

/** Host が Guest から受け取った生データを検証する。Host 発の型（init 等）は未知として拒否 */
export function parseGuestMessage(raw: unknown): ParseResult<GuestToHost> {
  return parse(GuestToHostSchema, raw);
}

/** Guest（SDK）が Host から受け取った生データを検証する。Guest 発の型（ready 等）は未知として拒否 */
export function parseHostMessage(raw: unknown): ParseResult<HostToGuest> {
  return parse(HostToGuestSchema, raw);
}

// ---- domain への橋渡し -----------------------------------------------------

/**
 * 検証済みメッセージを Host 状態機械のイベント（spec#6.4）に変換する。
 * `media` は Blob そのものではなくバイト数だけを渡す（domain は I/O を持たない）。
 */
export function toSessionEvent(m: Message): SessionEvent {
  switch (m.type) {
    case "ready":
      return {
        type: "ready",
        meta: { title: m.title, verb: m.verb, input: m.input, duration: m.duration },
      };
    case "init":
      return { type: "init", sessionId: m.session_id, mode: m.mode, timeLimit: m.time_limit };
    case "log":
      return { type: "log", sessionId: m.session_id };
    case "end": {
      const ev: Extract<SessionEvent, { type: "end" }> = {
        type: "end",
        sessionId: m.session_id,
        result: m.result,
        frames: m.frames,
      };
      if (m.score !== undefined) ev.score = m.score;
      if (m.checkpoint !== undefined) ev.checkpoint = m.checkpoint;
      return ev;
    }
    case "media":
      return { type: "media", sessionId: m.session_id, kind: m.kind, bytes: m.blob.size };
    case "error":
      return { type: "error", sessionId: m.session_id, message: m.message };
    case "start":
    case "pause":
    case "resume":
    case "destroy":
      return { type: m.type };
  }
}
