/**
 * Host 側のセッション状態機械（spec#6.4）。
 *
 * 純粋関数。I/O もタイマーも持たず、Host が「いま何時か（now, ms）」を渡す。
 * タイマーの開始・停止は effects として返し、実際のタイマーは Host が管理する。
 * 状態名は spec#13 のモデル A と同じ語彙を使う。
 */

export type Mode = "play" | "replay";
export type InputKind = "tap" | "hold" | "swipe" | "drag" | "stick" | "tilt";
export type Outcome = "win" | "lose";
export type MediaKind = "thumb" | "video";

/** `ready` に乗る、ゲームのメタ宣言（gc#A.3）。範囲検査は静的解析が行う。 */
export interface GameMeta {
  title: string;
  verb: string;
  input: InputKind;
  /** 論理フレーム数 */
  duration: number;
  /** 目標点。1 以上 */
  target: number;
}

export interface SessionResult {
  outcome: Outcome;
  score?: number;
  frames?: number;
  checkpoint?: string;
  /** guest: Guest の end、timeout: 監視タイマー満了、error: Guest の error */
  via: "guest" | "timeout" | "error";
  /** play セッションの結果だけをスコアにする（P2） */
  scoreable: boolean;
}

export type MediaSeen = { [K in MediaKind]: boolean };

export type SessionState =
  | { kind: "LOADING" }
  | { kind: "READY"; meta: GameMeta }
  | { kind: "INITED"; meta: GameMeta; sessionId: string; mode: Mode; timeLimit: number }
  | {
      kind: "RUNNING";
      meta: GameMeta;
      sessionId: string;
      mode: Mode;
      timeLimit: number;
      /** 監視タイマーの満了時刻（ms） */
      deadlineAt: number;
      media: MediaSeen;
    }
  | {
      kind: "PAUSED";
      meta: GameMeta;
      sessionId: string;
      mode: Mode;
      timeLimit: number;
      /** 残りの監視時間（ms）。PAUSED 中は減らない */
      remainingMs: number;
      media: MediaSeen;
    }
  | {
      kind: "ENDED";
      meta: GameMeta;
      sessionId: string;
      mode: Mode;
      result: SessionResult;
      media: MediaSeen;
    }
  | { kind: "DESTROYED" };

export const STATE_KINDS = [
  "LOADING",
  "READY",
  "INITED",
  "RUNNING",
  "PAUSED",
  "ENDED",
  "DESTROYED",
] as const satisfies readonly SessionState["kind"][];

/** Guest から届くメッセージ（spec#6.1）と Host 自身の操作をまとめたイベント。 */
export type SessionEvent =
  | { type: "ready"; meta: GameMeta }
  | { type: "init"; sessionId: string; mode: Mode; timeLimit: number }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "log"; sessionId: string }
  | {
      type: "end";
      sessionId: string;
      result: Outcome;
      score?: number;
      frames: number;
      checkpoint?: string;
    }
  | { type: "media"; sessionId: string; kind: MediaKind; bytes: number }
  | { type: "error"; sessionId: string; message: string }
  /** Host の監視タイマーが満了した */
  | { type: "timeout" }
  | { type: "destroy" };

export const EVENT_TYPES = [
  "ready",
  "init",
  "start",
  "pause",
  "resume",
  "log",
  "end",
  "media",
  "error",
  "timeout",
  "destroy",
] as const satisfies readonly SessionEvent["type"][];

type EventType = SessionEvent["type"];

/**
 * 遷移表。状態ごとに受理しうるイベント。
 * ここに無い組は無条件で拒否（reason: not_allowed）。ここに有る組も、個別の条件で拒否されうる。
 */
export const ALLOWED: Record<SessionState["kind"], readonly EventType[]> = {
  LOADING: ["ready", "destroy"],
  READY: ["init", "destroy"],
  INITED: ["start", "destroy"],
  RUNNING: ["pause", "log", "end", "media", "error", "timeout", "destroy"],
  PAUSED: ["resume", "log", "end", "media", "error", "destroy"],
  ENDED: ["init", "destroy"],
  DESTROYED: [],
};

export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  thumb: 64 * 1024,
  video: 2 * 1024 * 1024,
};

/** 監視タイマーの長さ。time_limit（フレーム）÷ 60 ＋ 1.5 秒。 */
export function watchdogMs(timeLimitFrames: number): number {
  return Math.round((timeLimitFrames / 60) * 1000) + 1500;
}

export type Effect = { type: "timer_start"; ms: number } | { type: "timer_stop" };

export type RejectReason =
  | "not_allowed"
  | "stale_session"
  | "expired"
  | "not_expired"
  | "media_too_large"
  | "media_duplicate";

export type TransitionResult =
  | { ok: true; state: SessionState; effects: Effect[] }
  | { ok: false; state: SessionState; reason: RejectReason };

export function initialSession(): SessionState {
  return { kind: "LOADING" };
}

const noMedia = (): MediaSeen => ({ thumb: false, video: false });

function ok(state: SessionState, effects: Effect[] = []): TransitionResult {
  return { ok: true, state, effects };
}
function reject(state: SessionState, reason: RejectReason): TransitionResult {
  return { ok: false, state, reason };
}

/**
 * 1 イベントぶんの遷移。拒否時は元の state をそのまま返す（参照同一）。
 * @param now 単調な現在時刻（ms）。Host の Clock から渡す。
 */
export function transition(
  state: SessionState,
  event: SessionEvent,
  now: number,
): TransitionResult {
  if (!ALLOWED[state.kind].includes(event.type)) return reject(state, "not_allowed");

  switch (event.type) {
    case "destroy":
      return ok({ kind: "DESTROYED" }, state.kind === "RUNNING" ? [{ type: "timer_stop" }] : []);

    case "ready":
      // LOADING でのみ許される（遷移表）
      return ok({ kind: "READY", meta: event.meta });

    case "init": {
      if (state.kind !== "READY" && state.kind !== "ENDED") return reject(state, "not_allowed");
      return ok({
        kind: "INITED",
        meta: state.meta,
        sessionId: event.sessionId,
        mode: event.mode,
        timeLimit: event.timeLimit,
      });
    }

    case "start": {
      if (state.kind !== "INITED") return reject(state, "not_allowed");
      const ms = watchdogMs(state.timeLimit);
      return ok(
        {
          kind: "RUNNING",
          meta: state.meta,
          sessionId: state.sessionId,
          mode: state.mode,
          timeLimit: state.timeLimit,
          deadlineAt: now + ms,
          media: noMedia(),
        },
        [{ type: "timer_start", ms }],
      );
    }

    case "pause": {
      if (state.kind !== "RUNNING") return reject(state, "not_allowed");
      return ok(
        {
          kind: "PAUSED",
          meta: state.meta,
          sessionId: state.sessionId,
          mode: state.mode,
          timeLimit: state.timeLimit,
          remainingMs: Math.max(0, state.deadlineAt - now),
          media: state.media,
        },
        [{ type: "timer_stop" }],
      );
    }

    case "resume": {
      if (state.kind !== "PAUSED") return reject(state, "not_allowed");
      return ok(
        {
          kind: "RUNNING",
          meta: state.meta,
          sessionId: state.sessionId,
          mode: state.mode,
          timeLimit: state.timeLimit,
          deadlineAt: now + state.remainingMs,
          media: state.media,
        },
        [{ type: "timer_start", ms: state.remainingMs }],
      );
    }

    case "log": {
      if (state.kind !== "RUNNING" && state.kind !== "PAUSED") return reject(state, "not_allowed");
      if (event.sessionId !== state.sessionId) return reject(state, "stale_session");
      return ok(state);
    }

    case "media": {
      if (state.kind !== "RUNNING" && state.kind !== "PAUSED") return reject(state, "not_allowed");
      if (event.sessionId !== state.sessionId) return reject(state, "stale_session");
      if (event.bytes > MEDIA_MAX_BYTES[event.kind]) return reject(state, "media_too_large");
      if (state.media[event.kind]) return reject(state, "media_duplicate");
      return ok({ ...state, media: { ...state.media, [event.kind]: true } });
    }

    case "end": {
      if (state.kind !== "RUNNING" && state.kind !== "PAUSED") return reject(state, "not_allowed");
      if (event.sessionId !== state.sessionId) return reject(state, "stale_session");
      if (state.kind === "RUNNING" && now >= state.deadlineAt) return reject(state, "expired");
      const result: SessionResult = {
        outcome: event.result,
        frames: event.frames,
        via: "guest",
        scoreable: state.mode === "play",
      };
      if (event.score !== undefined) result.score = event.score;
      if (event.checkpoint !== undefined) result.checkpoint = event.checkpoint;
      return ended(state, result);
    }

    case "error": {
      if (state.kind !== "RUNNING" && state.kind !== "PAUSED") return reject(state, "not_allowed");
      if (event.sessionId !== state.sessionId) return reject(state, "stale_session");
      return ended(state, { outcome: "lose", via: "error", scoreable: state.mode === "play" });
    }

    case "timeout": {
      if (state.kind !== "RUNNING") return reject(state, "not_allowed");
      if (now < state.deadlineAt) return reject(state, "not_expired");
      return ended(state, { outcome: "lose", via: "timeout", scoreable: state.mode === "play" });
    }
  }
}

function ended(
  state: Extract<SessionState, { kind: "RUNNING" | "PAUSED" }>,
  result: SessionResult,
): TransitionResult {
  return ok(
    {
      kind: "ENDED",
      meta: state.meta,
      sessionId: state.sessionId,
      mode: state.mode,
      result,
      media: state.media,
    },
    state.kind === "RUNNING" ? [{ type: "timer_stop" }] : [],
  );
}
