/**
 * Host 側のセッション状態機械（protocol#A.5、A.7、A.9）。
 *
 * 純粋関数。I/O もタイマーも持たず、Host が「いま何時か（now, ms）」を渡す。
 * タイマーの開始・停止は effects として返し、実際のタイマーは Host が管理する。
 * 状態名は `verification/Session.tla` と同じ語彙を使う。
 */

export type Mode = "play" | "replay";
/** `gf:input` の種別。`tilt` は予約（protocol#A.3）で、静的検査は受理しない（`ACCEPTED_INPUTS`） */
export type InputKind = "tap" | "hold" | "swipe" | "drag" | "stick" | "tilt";

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

/** `init.speed` が取りうる値。1.0〜1.5 の 1/8 刻み（protocol#A.8、run#A.8） */
export const SPEEDS = [1, 1.125, 1.25, 1.375, 1.5] as const;
export type Speed = (typeof SPEEDS)[number];
export const SPEED_MIN: Speed = 1;
export const SPEED_MAX: Speed = 1.5;
export function isSpeed(x: unknown): x is Speed {
  return (SPEEDS as readonly unknown[]).includes(x);
}

/** 1 セッションの結果（protocol#A.7）。`scoring.md` の入力になる。 */
export interface SessionResult {
  /** 整数 0〜2^31−1。`timeout` / `error` は 0 */
  score: number;
  /** 終了時のフレーム番号。`guest` は `end.frames`、`timeout` は `time_limit`。`error` では無い */
  frames?: number;
  /** guest: Guest の end、timeout: 監視タイマー満了、error: Guest の error */
  via: "guest" | "timeout" | "error";
  /** play セッションの結果だけをスコアにする（P2） */
  scoreable: boolean;
  /** `log` の順序違反を見つけた（protocol#A.9）。`scoring.md` では `flagged` になる */
  flagged: boolean;
}

/** `log` の受理履歴（protocol#A.9）。`fromFrame` の単調増加と重なりの検査に使う */
export interface LogSeen {
  /** 最後に受理した `log.from_frame`。まだ無ければ null */
  lastFrom: number | null;
  /** 受理した入力の最大フレーム。入力が無ければ −1 */
  maxFrame: number;
}

interface Active {
  meta: GameMeta;
  sessionId: string;
  mode: Mode;
  timeLimit: number;
  speed: Speed;
  log: LogSeen;
  flagged: boolean;
}

export type SessionState =
  | { kind: "LOADING" }
  | { kind: "READY"; meta: GameMeta }
  | {
      kind: "INITED";
      meta: GameMeta;
      sessionId: string;
      mode: Mode;
      timeLimit: number;
      speed: Speed;
    }
  | ({
      kind: "RUNNING";
      /** 監視タイマーの満了時刻（ms） */
      deadlineAt: number;
    } & Active)
  | ({
      kind: "PAUSED";
      /** 残りの監視時間（ms）。PAUSED 中は減らない */
      remainingMs: number;
    } & Active)
  | {
      kind: "ENDED";
      meta: GameMeta;
      sessionId: string;
      mode: Mode;
      result: SessionResult;
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

/** Guest から届くメッセージ（protocol#A.3）と Host 自身の操作をまとめたイベント。 */
export type SessionEvent =
  | { type: "ready"; meta: GameMeta }
  | { type: "init"; sessionId: string; mode: Mode; timeLimit: number; speed: Speed }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | {
      type: "log";
      sessionId: string;
      fromFrame: number;
      /** `inputs` の各要素のフレーム番号。順序の検査にだけ使う */
      inputFrames: readonly number[];
    }
  | { type: "end"; sessionId: string; score: number; frames: number }
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
  "error",
  "timeout",
  "destroy",
] as const satisfies readonly SessionEvent["type"][];

type EventType = SessionEvent["type"];

/**
 * 遷移表（protocol#A.5）。状態ごとに受理しうるイベント。
 * ここに無い組は無条件で拒否（reason: not_allowed）。ここに有る組も、個別の条件で拒否されうる。
 */
export const ALLOWED: Record<SessionState["kind"], readonly EventType[]> = {
  LOADING: ["ready", "destroy"],
  READY: ["init", "destroy"],
  INITED: ["start", "destroy"],
  RUNNING: ["pause", "log", "end", "error", "timeout", "destroy"],
  PAUSED: ["resume", "log", "end", "error", "destroy"],
  ENDED: ["init", "destroy"],
  DESTROYED: [],
};

/** 監視タイマーの猶予（ms）。protocol#A.7 の「＋ 1.5 秒」 */
export const WATCHDOG_GRACE_MS = 1500;

/** 監視タイマーの長さ。`time_limit ÷ (60 × speed)` 秒 ＋ 1.5 秒（protocol#A.7） */
export function watchdogMs(timeLimitFrames: number, speed: Speed): number {
  return Math.round((timeLimitFrames / (60 * speed)) * 1000) + WATCHDOG_GRACE_MS;
}

export type Effect = { type: "timer_start"; ms: number } | { type: "timer_stop" };

export type RejectReason =
  | "not_allowed"
  | "stale_session"
  | "expired"
  | "not_expired"
  /** `init.speed` が 5 値のどれでもない */
  | "invalid_speed"
  /** `end.frames` > `time_limit`（protocol#A.8） */
  | "frames_over_limit"
  /** `log.from_frame` が減った・重なった、入力が `from_frame` より前、または入力の frame が batch 内で減った（protocol#A.9、sc#A.2）。セッションは flagged */
  | "flagged_log_order"
  /** `log` の最大フレームが `end.frames` を超えている（protocol#A.9）。セッションは flagged */
  | "flagged_log_over_frames";

export type TransitionResult =
  | { ok: true; state: SessionState; effects: Effect[] }
  | { ok: false; state: SessionState; reason: RejectReason };

export function initialSession(): SessionState {
  return { kind: "LOADING" };
}

const noLog = (): LogSeen => ({ lastFrom: null, maxFrame: -1 });

function ok(state: SessionState, effects: Effect[] = []): TransitionResult {
  return { ok: true, state, effects };
}
function reject(state: SessionState, reason: RejectReason): TransitionResult {
  return { ok: false, state, reason };
}

/**
 * 1 イベントぶんの遷移。
 * 拒否時は元の state をそのまま返す（参照同一）。例外は `flagged_*` で、
 * このときは `flagged: true` を立てた state を返す（イベント自体は捨てる）。
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
      if (!isSpeed(event.speed)) return reject(state, "invalid_speed");
      return ok({
        kind: "INITED",
        meta: state.meta,
        sessionId: event.sessionId,
        mode: event.mode,
        timeLimit: event.timeLimit,
        speed: event.speed,
      });
    }

    case "start": {
      if (state.kind !== "INITED") return reject(state, "not_allowed");
      const ms = watchdogMs(state.timeLimit, state.speed);
      return ok(
        {
          kind: "RUNNING",
          meta: state.meta,
          sessionId: state.sessionId,
          mode: state.mode,
          timeLimit: state.timeLimit,
          speed: state.speed,
          deadlineAt: now + ms,
          log: noLog(),
          flagged: false,
        },
        [{ type: "timer_start", ms }],
      );
    }

    case "pause": {
      if (state.kind !== "RUNNING") return reject(state, "not_allowed");
      const { kind: _k, deadlineAt, ...rest } = state;
      return ok({ kind: "PAUSED", ...rest, remainingMs: Math.max(0, deadlineAt - now) }, [
        { type: "timer_stop" },
      ]);
    }

    case "resume": {
      if (state.kind !== "PAUSED") return reject(state, "not_allowed");
      const { kind: _k, remainingMs, ...rest } = state;
      return ok({ kind: "RUNNING", ...rest, deadlineAt: now + remainingMs }, [
        { type: "timer_start", ms: remainingMs },
      ]);
    }

    case "log": {
      if (state.kind !== "RUNNING" && state.kind !== "PAUSED") return reject(state, "not_allowed");
      if (event.sessionId !== state.sessionId) return reject(state, "stale_session");
      const { lastFrom, maxFrame } = state.log;
      // from_frame は前の log より後ろ。入力は from_frame 以上で、batch 内で単調非減少（sc#A.2）
      const ordered =
        (lastFrom === null || event.fromFrame > lastFrom) &&
        event.fromFrame > maxFrame &&
        event.inputFrames.every(
          (f, i) => f >= event.fromFrame && (i === 0 || f >= (event.inputFrames[i - 1] as number)),
        );
      if (!ordered) return reject({ ...state, flagged: true }, "flagged_log_order");
      const newMax = event.inputFrames.reduce((m, f) => Math.max(m, f), maxFrame);
      return ok({ ...state, log: { lastFrom: event.fromFrame, maxFrame: newMax } });
    }

    case "end": {
      if (state.kind !== "RUNNING" && state.kind !== "PAUSED") return reject(state, "not_allowed");
      if (event.sessionId !== state.sessionId) return reject(state, "stale_session");
      if (state.kind === "RUNNING" && now >= state.deadlineAt) return reject(state, "expired");
      if (event.frames > state.timeLimit) return reject(state, "frames_over_limit");
      if (state.log.maxFrame > event.frames) {
        return reject({ ...state, flagged: true }, "flagged_log_over_frames");
      }
      return ended(state, {
        score: event.score,
        frames: event.frames,
        via: "guest",
        scoreable: state.mode === "play",
        flagged: state.flagged,
      });
    }

    case "error": {
      if (state.kind !== "RUNNING" && state.kind !== "PAUSED") return reject(state, "not_allowed");
      if (event.sessionId !== state.sessionId) return reject(state, "stale_session");
      return ended(state, {
        score: 0,
        via: "error",
        scoreable: state.mode === "play",
        flagged: state.flagged,
      });
    }

    case "timeout": {
      if (state.kind !== "RUNNING") return reject(state, "not_allowed");
      if (now < state.deadlineAt) return reject(state, "not_expired");
      return ended(state, {
        score: 0,
        frames: state.timeLimit,
        via: "timeout",
        scoreable: state.mode === "play",
        flagged: state.flagged,
      });
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
    },
    state.kind === "RUNNING" ? [{ type: "timer_stop" }] : [],
  );
}
