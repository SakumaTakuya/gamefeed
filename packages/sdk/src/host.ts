/**
 * Host 側ブリッジ（protocol#A.2、A.5〜A.9）。
 *
 * Guest から届いたメッセージをスキーマで検証し、domain の状態機械（`transition`）に通す。
 * DOM に触らない。送信（iframe の `contentWindow.postMessage`）、時計、タイマーは `HostEnv` で受け取る。
 * 送り元の照合（`event.source === iframe.contentWindow`）は呼び出し側で済ませてから `receive` に渡す。
 */

import {
  type Effect,
  initialSession,
  type SessionEvent,
  type SessionState,
  type Speed,
  transition,
} from "@gamefeed/domain";
import {
  type HostToGuest,
  type InputLogEntry,
  parseGuestMessage,
  toSessionEvent,
} from "./messages.ts";

export interface HostEnv {
  /** Guest へ送る。 */
  post(message: HostToGuest): void;
  /** 単調増加の実時間（ms）。 */
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  newSessionId(): string;
  /** 0 以上の整数。 */
  newSeed(): number;
}

export interface Host {
  readonly state: SessionState;
  /** 現在のセッションで受理した入力ログ（`log` の連結。protocol#A.9）。 */
  readonly inputs: readonly InputLogEntry[];
  /** 直近の問題（Guest の `error.message`、またはプロトコル違反の理由）。なければ null。 */
  readonly problem: string | null;
  /** Guest から届いた生のメッセージ。 */
  receive(raw: unknown): void;
  /** READY / ENDED から新しいセッションを準備する。送れたら true。 */
  init(opts?: { speed?: Speed }): boolean;
  start(): boolean;
  pause(): boolean;
  resume(): boolean;
  /** どの状態からも破棄する。 */
  destroy(): void;
}

export function createHost(env: HostEnv, onChange: () => void = () => {}): Host {
  let state: SessionState = initialSession();
  let inputs: InputLogEntry[] = [];
  let problem: string | null = null;
  let timer: unknown = null;

  function stopTimer(): void {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  }

  function apply(effects: readonly Effect[]): void {
    for (const e of effects) {
      stopTimer();
      if (e.type === "timer_start") {
        timer = env.setTimer(() => {
          timer = null;
          dispatch({ type: "timeout" });
        }, e.ms);
      }
    }
  }

  /** 状態機械に 1 イベント通す。受理されたら true。拒否でも flagged は state に残る */
  function dispatch(event: SessionEvent): boolean {
    const r = transition(state, event, env.now());
    const changed = r.state !== state;
    state = r.state;
    if (r.ok) apply(r.effects);
    if (changed) onChange();
    return r.ok;
  }

  function destroy(reason?: string): void {
    if (state.kind === "DESTROYED") return;
    if (reason !== undefined) problem = reason;
    stopTimer();
    dispatch({ type: "destroy" });
    env.post({ type: "destroy" });
  }

  return {
    get state() {
      return state;
    },
    get inputs() {
      return inputs;
    },
    get problem() {
      return problem;
    },

    receive(raw) {
      if (state.kind === "DESTROYED") return;
      const parsed = parseGuestMessage(raw);
      if (!parsed.ok) {
        // スキーマ違反は即セッション破棄（protocol#A.2）
        destroy(`プロトコル違反: ${parsed.reason}`);
        return;
      }
      const m = parsed.message;
      if (!dispatch(toSessionEvent(m))) return;
      // dispatch の中の通知は inputs / problem を更新する前なので、更新した後にもう一度知らせる
      if (m.type === "log") {
        inputs = [...inputs, ...m.inputs];
        onChange();
      } else if (m.type === "error") {
        problem = m.message;
        onChange();
      }
    },

    init(opts = {}) {
      if (state.kind !== "READY" && state.kind !== "ENDED") return false;
      const sessionId = env.newSessionId();
      const speed = opts.speed ?? 1;
      const timeLimit = state.meta.duration;
      if (!dispatch({ type: "init", sessionId, mode: "play", timeLimit, speed })) return false;
      inputs = [];
      problem = null;
      env.post({
        type: "init",
        session_id: sessionId,
        seed: env.newSeed(),
        mode: "play",
        time_limit: timeLimit,
        speed,
      });
      return true;
    },

    start() {
      if (!dispatch({ type: "start" })) return false;
      env.post({ type: "start" });
      return true;
    },

    pause() {
      if (!dispatch({ type: "pause" })) return false;
      env.post({ type: "pause" });
      return true;
    },

    resume() {
      if (!dispatch({ type: "resume" })) return false;
      env.post({ type: "resume" });
      return true;
    },

    destroy: () => destroy(),
  };
}
