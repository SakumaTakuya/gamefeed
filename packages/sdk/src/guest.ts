/**
 * Guest 側ランタイムの本体（protocol#A.2〜A.10、gc#A.4）。
 *
 * DOM に触らない。送信（postMessage）と実時間の時計は `GuestEnv` で受け取り、
 * 描画タイミング（requestAnimationFrame）と入力（pointer イベント）は呼び出し側が `frame()` / `input()` で伝える。
 * ブラウザへの組み込み（`window.GF`、メタ宣言の読み取り、イベントの購読）は別のモジュールが行う。
 */

import type { GameMeta, Mode } from "@gamefeed/domain";
import {
  type GuestToHost,
  type InputLogEntry,
  type InputLogKind,
  parseHostMessage,
  SCORE_MAX,
  SDK_PROTOCOL_VERSION,
} from "./messages.ts";

export interface GuestEnv {
  /** Host へ送る（`window.parent.postMessage`）。 */
  post(message: GuestToHost): void;
  /** 単調増加の実時間（ms）。ゲームから差し替えられる前の `performance.now`。 */
  now(): number;
}

export type GuestState =
  | "LOADING"
  | "READY"
  | "INITED"
  | "RUNNING"
  | "PAUSED"
  | "ENDED"
  | "DESTROYED";

export interface InputEvent {
  frame: number;
  kind: InputLogKind;
  data: number[];
}

/** ゲームが使う `GF`（gc#A.4）。`audio` / `stick` は別 Issue。 */
export interface GF {
  onInit(cb: (arg: { seed: number; mode: Mode }) => void): void;
  onStart(cb: () => void): void;
  onTick(cb: (frame: number) => void): void;
  onDraw(cb: (alpha: number) => void): void;
  onInput(cb: (ev: InputEvent) => void): void;
  /** 0 以上 1 未満の決定論的な乱数。`init.seed` から初期化される。 */
  rng(): number;
  /** 現在の論理フレーム番号（0 から）。 */
  readonly frame: number;
  readonly timeLimit: number;
  readonly timeLeft: number;
  /** ゲームが書き換える。`end` を送るときにクランプする。 */
  score: number;
  /** 早く終える。1 回だけ効く。 */
  end(): void;
}

export interface Guest {
  readonly GF: GF;
  readonly state: GuestState;
  /** `ready` を送る。メタ宣言を読めるようになったら 1 回だけ呼ぶ。 */
  ready(meta: GameMeta): void;
  /** Host から届いた生のメッセージ。送り元（`event.source`）の照合は呼び出し側で済ませる。 */
  receive(raw: unknown): void;
  /** 描画タイミングごとに呼ぶ。たまった tick を進め、`onDraw` を呼ぶ。 */
  frame(): void;
  /** DOM 由来の入力。play の RUNNING 中だけ受け、次の tick のフレーム番号で記録する。 */
  input(kind: InputLogKind, data: readonly number[]): void;
}

/** 1 描画あたりに追いつく tick の上限（protocol#A.4）。 */
export const MAX_TICKS_PER_FRAME = 5;
/** `log` を送る間隔（フレーム。protocol#A.3）。 */
export const LOG_INTERVAL = 64;
/** `error.message` の上限（文字）。 */
export const ERROR_MESSAGE_MAX = 500;
/** 浮動小数の誤差で 1 tick 遅れないための余裕（tick 単位）。 */
const EPS = 1e-6;

/**
 * mulberry32。アルゴリズムを変えると過去のリプレイが崩れるので変えない。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** gc#A.4 / protocol#A.10: 整数・0 以上・2^31−1 以下。数でないもの・数に直せないものは 0。 */
export function clampScore(value: unknown): number {
  let n: number;
  try {
    // Symbol や、変換で例外を投げるオブジェクトでも end を送れるようにする
    n = Number(value);
  } catch {
    return 0;
  }
  if (Number.isNaN(n)) return 0;
  return Math.min(SCORE_MAX, Math.max(0, Math.trunc(n)));
}

export function createGuest(env: GuestEnv): Guest {
  let state: GuestState = "LOADING";

  // ゲームのコールバック
  let onInit: ((arg: { seed: number; mode: Mode }) => void) | undefined;
  let onStart: (() => void) | undefined;
  let onTick: ((frame: number) => void) | undefined;
  let onDraw: ((alpha: number) => void) | undefined;
  let onInput: ((ev: InputEvent) => void) | undefined;

  // セッション
  let sessionId = "";
  let mode: Mode = "play";
  let timeLimit = 0;
  /** 1 ms あたりの tick 数（speed × 60 ÷ 1000） */
  let ticksPerMs = 0.06;
  let rng = mulberry32(0);
  let score: unknown = 0;
  /** これまでに実行した tick の数。次の tick のフレーム番号でもある */
  let frame = 0;
  let endRequested = false;

  // 壁時計（pause 中は進めない）
  let activeMs = 0;
  let resumedAt = 0;

  // 入力
  /** play: 次の tick で渡す DOM 入力 */
  let pending: { kind: InputLogKind; data: number[] }[] = [];
  /** replay: `init.inputs` と、次に渡す位置 */
  let replayInputs: readonly InputLogEntry[] = [];
  let replayAt = 0;
  /** まだ `log` で送っていない入力と、その先頭フレーム */
  let logBuffer: InputLogEntry[] = [];
  let logFrom = 0;

  const live = (): boolean => state === "INITED" || state === "RUNNING" || state === "PAUSED";

  /** コールバックを呼ぶ。例外は最初の 1 回だけ `error` にする（protocol#A.10）。成功なら true */
  function call<A extends unknown[]>(cb: ((...args: A) => void) | undefined, ...args: A): boolean {
    if (!cb) return true;
    try {
      cb(...args);
      return true;
    } catch (e) {
      // end の後・destroy の後の例外は無視する
      if (!live()) return false;
      state = "ENDED";
      let message: string;
      try {
        message = String(e);
      } catch {
        message = "error";
      }
      env.post({
        type: "error",
        session_id: sessionId,
        message: message.slice(0, ERROR_MESSAGE_MAX),
      });
      return false;
    }
  }

  function flushLog(): void {
    env.post({ type: "log", session_id: sessionId, from_frame: logFrom, inputs: logBuffer });
    logBuffer = [];
    logFrom = frame;
  }

  /** 最後の `log` と `end`（protocol#A.4）。 */
  function finish(): void {
    flushLog();
    state = "ENDED";
    env.post({ type: "end", session_id: sessionId, score: clampScore(score), frames: frame });
  }

  /** この tick に渡す入力を取り出す。フレーム番号はここで付く */
  function takeInputs(): InputLogEntry[] {
    if (mode === "replay") {
      const out: InputLogEntry[] = [];
      for (;;) {
        const e = replayInputs[replayAt];
        if (!e || e[0] > frame) break;
        replayAt++;
        // 過ぎたフレームの入力（壊れたログ）は渡さない
        if (e[0] === frame) out.push(e);
      }
      return out;
    }
    const out = pending.map((p) => [frame, p.kind, ...p.data] as unknown as InputLogEntry);
    pending = [];
    return out;
  }

  /** 1 tick。続けてよければ true */
  function tick(): boolean {
    for (const entry of takeInputs()) {
      logBuffer.push(entry);
      const [f, kind, ...data] = entry;
      if (!call(onInput, { frame: f, kind, data })) return false;
    }
    if (!call(onTick, frame)) return false;
    frame++;
    if (endRequested || frame >= timeLimit) {
      finish();
      return false;
    }
    if (frame % LOG_INTERVAL === 0) flushLog();
    return true;
  }

  function init(m: Extract<ReturnType<typeof parseHostMessage>, { ok: true }>["message"]): void {
    if (m.type !== "init") return;
    sessionId = m.session_id;
    mode = m.mode;
    timeLimit = m.time_limit;
    ticksPerMs = (m.speed * 60) / 1000;
    rng = mulberry32(m.seed);
    score = 0;
    frame = 0;
    endRequested = false;
    activeMs = 0;
    pending = [];
    replayInputs = m.inputs ?? [];
    replayAt = 0;
    logBuffer = [];
    logFrom = 0;
    state = "INITED";
    call(onInit, { seed: m.seed, mode: m.mode });
  }

  const GF: GF = {
    onInit: (cb) => {
      onInit = cb;
    },
    onStart: (cb) => {
      onStart = cb;
    },
    onTick: (cb) => {
      onTick = cb;
    },
    onDraw: (cb) => {
      onDraw = cb;
    },
    onInput: (cb) => {
      onInput = cb;
    },
    rng: () => rng(),
    get frame() {
      return frame;
    },
    get timeLimit() {
      return timeLimit;
    },
    get timeLeft() {
      return Math.max(0, timeLimit - frame);
    },
    get score() {
      return score as number;
    },
    set score(value: number) {
      score = value;
    },
    end: () => {
      // 終わるのは次に実行する tick の直後。frames が 1 以上になる（scoring の受理条件）
      if (live()) endRequested = true;
    },
  };

  return {
    GF,
    get state() {
      return state;
    },

    ready(meta) {
      if (state !== "LOADING") return;
      state = "READY";
      env.post({ type: "ready", sdk: SDK_PROTOCOL_VERSION, ...meta });
    },

    receive(raw) {
      if (state === "DESTROYED") return;
      const parsed = parseHostMessage(raw);
      // ready の前に届いたものは捨てる。destroy だけはどの状態でも効く（protocol#A.5）
      if (state === "LOADING") {
        if (parsed.ok && parsed.message.type === "destroy") state = "DESTROYED";
        return;
      }
      if (!parsed.ok) {
        // スキーマ違反は即セッション破棄。以後すべて無視する（protocol#A.2）
        state = "DESTROYED";
        return;
      }
      const m = parsed.message;
      switch (m.type) {
        case "init":
          if (
            state === "READY" ||
            state === "ENDED" ||
            ((state === "RUNNING" || state === "PAUSED") && mode === "replay")
          ) {
            init(m);
          }
          return;
        case "start":
          if (state !== "INITED") return;
          state = "RUNNING";
          activeMs = 0;
          resumedAt = env.now();
          call(onStart);
          return;
        case "pause":
          if (state !== "RUNNING") return;
          activeMs += env.now() - resumedAt;
          state = "PAUSED";
          return;
        case "resume":
          if (state !== "PAUSED") return;
          resumedAt = env.now();
          state = "RUNNING";
          return;
        case "destroy":
          state = "DESTROYED";
          return;
      }
    },

    frame() {
      if (state !== "RUNNING") return;
      const elapsed = activeMs + (env.now() - resumedAt);
      const due = Math.floor(elapsed * ticksPerMs + EPS) - frame;
      let ran = 0;
      while (ran < Math.min(due, MAX_TICKS_PER_FRAME)) {
        ran++;
        if (!tick()) break;
      }
      // 端末が遅くてフレームが足りなくても、壁時計で終える（protocol#A.4）
      if (state === "RUNNING" && elapsed * ticksPerMs + EPS >= timeLimit) {
        if (frame === 0 && !tick()) return;
        if (state === "RUNNING") finish();
      }
      // 終わった描画タイミングでも最後の状態を描く。ここでの例外は call が無視する
      if (state === "RUNNING" || state === "ENDED") {
        const alpha = state === "RUNNING" ? elapsed * ticksPerMs - frame : 0;
        call(onDraw, Math.min(Math.max(alpha, 0), 1 - EPS));
      }
    },

    input(kind, data) {
      if (state !== "RUNNING" || mode !== "play") return;
      pending.push({ kind, data: [...data] });
    },
  };
}
