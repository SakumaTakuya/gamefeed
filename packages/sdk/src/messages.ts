/**
 * Host↔Guest メッセージスキーマ（protocol#A.2、A.3）。
 *
 * 9 種のメッセージ（Guest 4 種、Host 5 種）を valibot で定義し、Host と Guest の両側で同じ検証を使う。
 * 違反は呼び出し側（Host ブリッジ / Guest SDK）が即セッション破棄にする（protocol#A.2）。
 *
 * ワイヤ形式は `{type, ...payload}` のフラットな JSON。キーは snake_case（protocol#A.2、B.8）。
 * domain の `SessionEvent`（camelCase）への変換は `toSessionEvent` が担う。
 *
 * zod ではなく valibot を使う理由: SDK は全ゲームの <head> に注入されるため（gc#A.4）、
 * バンドルサイズが効く。同じスキーマで valibot ≈ 2.4 KB gz、zod/mini ≈ 8.5 KB gz、zod ≈ 54 KB gz（#7）。
 */

import {
  ACCEPTED_INPUTS,
  DURATION_MAX,
  DURATION_MIN,
  graphemeCount,
  type InputKind,
  type Mode,
  type SessionEvent,
  SPEEDS,
  TARGET_MIN,
  VERB_MAX_CHARS,
} from "@gamefeed/domain";
import * as v from "valibot";

/** protocol#A.2。Host は自分が知らないメジャーを拒否する */
export const SDK_PROTOCOL_VERSION = "2.0";
export const SDK_PROTOCOL_MAJOR = 2;

/** gc#A.4 / protocol#A.3: 0 ≤ score ≤ 2^31−1 */
export const SCORE_MAX = 2 ** 31 - 1;

/** 入力ログに現れる種別（protocol#A.3）。`stick` は `drag` 列から解釈し、`tilt` は予約 */
export const INPUT_LOG_KINDS = ["tap", "hold", "swipe", "drag"] as const;
export type InputLogKind = (typeof INPUT_LOG_KINDS)[number];

export const MESSAGE_TYPES = [
  "ready",
  "log",
  "end",
  "error",
  "init",
  "start",
  "pause",
  "resume",
  "destroy",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

// ---- 部品 ----------------------------------------------------------------

const nonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0));
const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));
const sessionId = v.pipe(v.string(), v.nonEmpty("session_id が空です"));
/** 画面に対する 0〜1 の正規化座標（gc#A.4） */
const coord = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
/** hold / drag の押下（1）・離し（0） */
const pressed = v.picklist([0, 1]);

/**
 * `log.inputs` の 1 要素（protocol#A.3）。kind ごとに長さと型が決まっている。
 * tap `[frame, "tap", x, y]`、hold / drag `[frame, kind, x, y, 1|0]`、swipe `[frame, "swipe", x0, y0, x1, y1]`
 */
const inputLogEntry = v.union([
  v.strictTuple([nonNegativeInt, v.literal("tap"), coord, coord]),
  v.strictTuple([nonNegativeInt, v.literal("hold"), coord, coord, pressed]),
  v.strictTuple([nonNegativeInt, v.literal("swipe"), coord, coord, coord, coord]),
  v.strictTuple([nonNegativeInt, v.literal("drag"), coord, coord, pressed]),
]);
export type InputLogEntry = v.InferOutput<typeof inputLogEntry>;

/** `"<major>.<minor>"`。メジャーが一致するものだけ受理する（protocol#A.2） */
const sdkVersion = v.pipe(
  v.string(),
  v.regex(/^\d+\.\d+$/, "sdk は <major>.<minor> 形式"),
  v.check(
    (s) => Number(s.split(".")[0]) === SDK_PROTOCOL_MAJOR,
    `sdk のメジャーは ${SDK_PROTOCOL_MAJOR} のみ`,
  ),
);

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

// ---- Guest → Host --------------------------------------------------------

const ready = v.strictObject({
  type: v.literal("ready"),
  sdk: sdkVersion,
  title: v.pipe(v.string(), v.trim(), v.nonEmpty("title が空です")),
  verb,
  input: v.picklist(ACCEPTED_INPUTS as readonly InputKind[]),
  duration,
  target: v.pipe(v.number(), v.integer(), v.minValue(TARGET_MIN)),
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
  score: v.pipe(nonNegativeInt, v.maxValue(SCORE_MAX)),
  frames: nonNegativeInt,
});

const error = v.strictObject({
  type: v.literal("error"),
  session_id: sessionId,
  message: v.string(),
});

export const GuestToHostSchema = v.variant("type", [ready, log, end, error]);
export type GuestToHost = v.InferOutput<typeof GuestToHostSchema>;

// ---- Host → Guest --------------------------------------------------------

const init = v.pipe(
  v.strictObject({
    type: v.literal("init"),
    session_id: sessionId,
    seed: nonNegativeInt,
    mode: v.picklist(["play", "replay"] satisfies readonly Mode[]),
    time_limit: positiveInt,
    /** protocol#A.8: 1.0〜1.5 の 1/8 刻み */
    speed: v.picklist(SPEEDS),
    inputs: v.optional(v.array(inputLogEntry)),
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
 * 検証済みメッセージを Host 状態機械のイベント（protocol#A.5）に変換する。
 * `log` は入力の中身ではなくフレーム番号だけを渡す（順序の検査に使う。protocol#A.9）。
 */
export function toSessionEvent(m: Message): SessionEvent {
  switch (m.type) {
    case "ready":
      return {
        type: "ready",
        meta: {
          title: m.title,
          verb: m.verb,
          input: m.input,
          duration: m.duration,
          target: m.target,
        },
      };
    case "init":
      return {
        type: "init",
        sessionId: m.session_id,
        mode: m.mode,
        timeLimit: m.time_limit,
        speed: m.speed,
      };
    case "log":
      return {
        type: "log",
        sessionId: m.session_id,
        fromFrame: m.from_frame,
        inputFrames: m.inputs.map((e) => e[0]),
      };
    case "end":
      return { type: "end", sessionId: m.session_id, score: m.score, frames: m.frames };
    case "error":
      return { type: "error", sessionId: m.session_id, message: m.message };
    case "start":
    case "pause":
    case "resume":
    case "destroy":
      return { type: m.type };
  }
}
