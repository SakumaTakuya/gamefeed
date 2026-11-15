/**
 * ラン Host のスロット制御（run#A.4〜A.7、A.9）。ラン画面の頭脳。
 *
 * 純粋関数。DOM も通信もタイマーも持たない。iframe の生成・メッセージの送信・API の呼び出し・タイマーは
 * effects として返し、ラン画面が実行して結果をイベントで戻す。
 * 遷移の名前は `verification/Run.tla` と同じ語彙（Issue / Ready / Inited / Start / SkipLoad / End /
 * NoMoreTurns / Finish）で、コメントに対応を書く。
 *
 * - スロットは N（表示中）と、次に出す 2 本（N+1、N+2）。生きている iframe は 3 枚以下（F3、F4）
 * - `start` を出すのは幕間の終わりの 1 か所で、INITED のスロットにだけ（F5）
 * - ミスは `end` の瞬間に凍結した `miss_below` で判定する。通信を待たない（F8）
 * - ランが終わったら、送った `result` の応答がそろってから `finish` を出す（run#A.7）
 * 最初の手番の始め方・発行待ちの幕間・非表示の間の扱いなどは文書に無く、#149 の案で実装している。
 */

import { isMiss, type ResultVia } from "./result.ts";
import { ENDLESS_LIVES } from "./run-record.ts";

/** 結果フラッシュの長さ（run#A.5 の 2。暫定） */
export const FLASH_MS = 500;
/** 幕間の長さ（run#A.5 の 4。暫定） */
export const INTERLUDE_MS = 1000;
/** 幕間の延長の上限（run#A.5 の 6。暫定） */
export const INTERLUDE_EXTENSION_MS = 3000;
/** `result` の再送の回数と間隔（run#A.7。暫定） */
export const RESULT_RETRIES = 2;
export const RESULT_RETRY_MS = 1000;
/** 非表示のままこの時間が経ったら中断する（run#A.9。暫定）。計るのはラン画面で、`abort` を送る */
export const HIDDEN_ABORT_MS = 10 * 60 * 1000;
/** 先に用意しておく手番の数（スロット N+1、N+2） */
export const PREFETCH_SLOTS = 2;

/** `next` が発行した手番のうち、進行に使うもの。ほかの値（seed、speed など）はラン画面が手番番号で持つ */
export interface HostTurn {
  turn: number;
  sessionId: string;
  /** 発行時に凍結した閾値。新作枠・校正中・デイリーは null（ミスにならない） */
  missBelow: number | null;
}

/** 不可視スロットの iframe の状態（protocol#A.5 のうち、ランが区別するもの） */
export type PendingFrame = "LOADING" | "READY" | "INITED";

export interface PendingSlot {
  turn: HostTurn;
  frame: PendingFrame;
}

/** 表示中の手番（スロット N） */
export interface CurrentSlot {
  turn: HostTurn;
  frame: "RUNNING" | "PAUSED" | "ENDED";
}

/** 送って応答を待っている `result` */
export interface PendingResult {
  turn: number;
  /** 読み込みの skip（本文は `{skipped: true}`） */
  skipped: boolean;
  /** 応答が来なかった回数 */
  failures: number;
}

export type RunPhase =
  /** スタートの操作を待っている。先読みは進む */
  | "idle"
  /** 手番 N が動いている（非表示で止めている間を含む） */
  | "running"
  /** 結果フラッシュ */
  | "flash"
  /** 幕間（延長と、次の手番の発行待ちを含む） */
  | "interlude"
  /** 表示に戻った後の「続きから」の幕間 */
  | "resuming"
  /** ランは終わった。`result` の応答を待っている */
  | "closing"
  /** `finish` を出した */
  | "finished";

export type TimerName = "flash" | "interlude" | "extension" | "resume";

export interface RunHostState {
  phase: RunPhase;
  current: CurrentSlot | null;
  /** 次に出す手番。手番番号の順で、先頭が N+1 */
  pending: readonly PendingSlot[];
  /** 次に始める（または skip にする）手番番号。サーバは 0 から連番で発行する（run#A.3） */
  nextTurn: number;
  /** 応答待ちの `next` の数 */
  requesting: number;
  /** サーバが `{done: true}` を返した。もう発行を頼まない */
  serverDone: boolean;
  lives: number;
  /** 直前に終わった手番の表示用の値（結果フラッシュ） */
  last: { turn: number; via: ResultVia; score: number; miss: boolean } | null;
  /** 読み込みの skip になった手番 */
  skipped: readonly number[];
  /** タブが非表示 */
  hidden: boolean;
  /** 動いているタイマー。イベントの id が違えば古いタイマーとして捨てる */
  timer: { id: number; name: TimerName } | null;
  timerSeq: number;
  /** 応答待ちの `result`（キーは session_id） */
  results: Readonly<Record<string, PendingResult>>;
}

export type RunHostEvent =
  /** スタートの操作（「タップしてスタート」） */
  | { type: "begin" }
  /** `next` が手番を返した（Issue） */
  | { type: "turn_issued"; turn: HostTurn }
  /** `next` が `{done: true}` を返した */
  | { type: "turn_done" }
  /** 不可視スロットの Guest から `ready` が届いた（Ready） */
  | { type: "ready"; turn: number }
  /** Host が `init` を送り終えた（Inited） */
  | { type: "inited"; turn: number }
  /** 表示中の手番が終わった: `end`、監視タイマー満了、`error`（End） */
  | { type: "end"; turn: number; via: ResultVia; score: number }
  | { type: "timer"; id: number }
  /** `result` の応答が届いた（受理でも拒否でも 409 でも） */
  | { type: "result_settled"; sessionId: string }
  /** `result` の応答が来なかった */
  | { type: "result_failed"; sessionId: string }
  /** タブが非表示になった / 表示に戻った（run#A.9） */
  | { type: "hide" }
  | { type: "show" }
  /** 中断（非表示のまま HIDDEN_ABORT_MS、ユーザーの操作） */
  | { type: "abort" };

export type RunHostEffect =
  /** `POST /runs/{id}/next` を呼ぶ */
  | { type: "request_next" }
  /** 不可視の iframe を作って読み込む */
  | { type: "load"; turn: number }
  /** そのスロットに `init` を送る */
  | { type: "init"; turn: number }
  /** そのスロットを表示して `start` を送る */
  | { type: "start"; turn: number }
  | { type: "pause"; turn: number }
  | { type: "resume"; turn: number }
  /** `destroy` を送って iframe を外す */
  | { type: "destroy"; turn: number }
  | { type: "timer"; id: number; name: TimerName; ms: number }
  /** `PUT /sessions/{id}/result` を送る。skipped なら本文は `{skipped: true}`。delayMs は再送の待ち */
  | { type: "send_result"; sessionId: string; turn: number; skipped: boolean; delayMs: number }
  /** `POST /runs/{id}/finish` を呼ぶ */
  | { type: "finish" };

export type RunHostReject =
  /** その phase では受けないイベント */
  | "not_allowed"
  /** 知らない手番・セッション、または古いタイマー */
  | "stale";

export type RunHostResult =
  | { ok: true; state: RunHostState; effects: RunHostEffect[] }
  | { ok: false; state: RunHostState; reason: RunHostReject };

/** ランの始まり。スロット N+1、N+2 にあたる 2 手番の発行を頼む */
export function initialRunHost(lives: number = ENDLESS_LIVES): {
  state: RunHostState;
  effects: RunHostEffect[];
} {
  const state: RunHostState = {
    phase: "idle",
    current: null,
    pending: [],
    nextTurn: 0,
    requesting: PREFETCH_SLOTS,
    serverDone: false,
    lives,
    last: null,
    skipped: [],
    hidden: false,
    timer: null,
    timerSeq: 0,
    results: {},
  };
  return {
    state,
    effects: Array.from({ length: PREFETCH_SLOTS }, () => ({ type: "request_next" })),
  };
}

const over = (s: RunHostState): boolean => s.phase === "closing" || s.phase === "finished";

/** 生きている iframe の数（F4） */
export function aliveFrames(s: RunHostState): number {
  return s.pending.length + (s.current ? 1 : 0);
}

function arm(s: RunHostState, name: TimerName, ms: number, effects: RunHostEffect[]): RunHostState {
  const id = s.timerSeq + 1;
  effects.push({ type: "timer", id, name, ms });
  return { ...s, timer: { id, name }, timerSeq: id };
}

/** 空いたスロットのぶんだけ発行を頼む（Issue の前提: 待ちの手番は 2 本まで） */
function refill(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  let requesting = s.requesting;
  while (!s.serverDone && s.pending.length + requesting < PREFETCH_SLOTS) {
    requesting++;
    effects.push({ type: "request_next" });
  }
  return { ...s, requesting };
}

/** ランを終える（Finish）。iframe をすべて外し、`result` の応答がそろえば `finish` を出す */
function close(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  for (const slot of [...(s.current ? [s.current] : []), ...s.pending]) {
    effects.push({ type: "destroy", turn: slot.turn.turn });
  }
  return settle({ ...s, phase: "closing", current: null, pending: [], timer: null }, effects);
}

function settle(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  if (s.phase !== "closing" || Object.keys(s.results).length > 0) return s;
  effects.push({ type: "finish" });
  return { ...s, phase: "finished" };
}

/**
 * 幕間の終わり（run#A.5 の 5〜6）。先頭の手番が INITED なら `start`（Start）、まだなら延長、
 * 手番がもう来ないならランを終える（NoMoreTurns）。
 */
function advance(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  const head = s.pending[0];
  // `next` の応答は頼んだ順に届くとは限らない。先頭が次の手番番号でなければ、間の手番がまだ届いていない
  const missing = !head || (head.turn.turn !== s.nextTurn && s.requesting > 0);
  if (!head || missing) {
    if (!head && s.serverDone && s.requesting === 0) return close(s, effects);
    // 発行の応答を待つ。届いたら延長を計り始める
    return { ...s, timer: null };
  }
  // 非表示の間は始めず、延長も計らない。表示に戻ったら幕間を出し直す（run#A.9）
  if (s.hidden) return { ...s, timer: null };
  if (head.frame !== "INITED") return arm(s, "extension", INTERLUDE_EXTENSION_MS, effects);

  effects.push({ type: "start", turn: head.turn.turn });
  if (s.current) effects.push({ type: "destroy", turn: s.current.turn.turn });
  const started: RunHostState = {
    ...s,
    phase: "running",
    current: { turn: head.turn, frame: "RUNNING" },
    pending: s.pending.slice(1),
    nextTurn: head.turn.turn + 1,
    timer: null,
  };
  return refill(started, effects);
}

/** 幕間が延長の上限に達した: 先頭の手番を skip にして、次を繰り上げる（SkipLoad。run#A.5 の 6） */
function skipLoad(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  const head = s.pending[0];
  if (!head) return s;
  effects.push({ type: "destroy", turn: head.turn.turn });
  effects.push({
    type: "send_result",
    sessionId: head.turn.sessionId,
    turn: head.turn.turn,
    skipped: true,
    delayMs: 0,
  });
  const next: RunHostState = {
    ...s,
    pending: s.pending.slice(1),
    nextTurn: head.turn.turn + 1,
    skipped: [...s.skipped, head.turn.turn],
    results: {
      ...s.results,
      [head.turn.sessionId]: { turn: head.turn.turn, skipped: true, failures: 0 },
    },
  };
  // 空いたスロットを埋め、幕間からやり直す（残機は減らさない。手番は消費している）
  return arm(refill(next, effects), "interlude", INTERLUDE_MS, effects);
}

const done = (state: RunHostState, effects: RunHostEffect[]): RunHostResult => ({
  ok: true,
  state,
  effects,
});
const reject = (state: RunHostState, reason: RunHostReject): RunHostResult => ({
  ok: false,
  state,
  reason,
});

/**
 * 1 イベントぶんの遷移。拒否したときは元の state をそのまま返す（参照同一）。
 * ランが終わった後に届いた発行・`ready` などは捨てる（発行済みの手番はそのまま捨てられる。run#A.3）。
 */
export function runHostStep(s: RunHostState, e: RunHostEvent): RunHostResult {
  const effects: RunHostEffect[] = [];
  const setPending = (turn: number, from: PendingFrame, to: PendingFrame): RunHostState | null => {
    const i = s.pending.findIndex((p) => p.turn.turn === turn);
    if (i < 0 || s.pending[i]?.frame !== from) return null;
    return { ...s, pending: s.pending.map((p, j) => (j === i ? { ...p, frame: to } : p)) };
  };

  switch (e.type) {
    case "turn_issued": {
      if (s.requesting === 0) return reject(s, "stale");
      const got = { ...s, requesting: s.requesting - 1 };
      // 終わったランに届いた手番は読み込まない
      if (over(s)) return done(got, effects);
      effects.push({ type: "load", turn: e.turn.turn });
      // 届いた順ではなく手番番号の順に並べる（応答の順が入れ替わっても、始める順はサーバの手番どおり）
      const pending = [...s.pending, { turn: e.turn, frame: "LOADING" as const }].sort(
        (a, b) => a.turn.turn - b.turn.turn,
      );
      const next = { ...got, pending };
      // 幕間の終わりに次の手番が無くて待っていたなら、それが届いた時点から延長を計る
      const waiting = s.phase === "interlude" && s.timer === null && !s.hidden;
      const arrived = pending[0]?.turn.turn === s.nextTurn || next.requesting === 0;
      return done(
        waiting && arrived ? arm(next, "extension", INTERLUDE_EXTENSION_MS, effects) : next,
        effects,
      );
    }

    case "turn_done": {
      if (s.requesting === 0) return reject(s, "stale");
      const got = { ...s, requesting: s.requesting - 1, serverDone: true };
      // 待っていた発行がすべて返った。手番が残っていなければここで終わる（非表示の間でも終える）
      const waiting = s.phase === "interlude" && s.timer === null;
      return done(waiting && got.requesting === 0 ? advance(got, effects) : got, effects);
    }

    case "ready": {
      const next = setPending(e.turn, "LOADING", "READY");
      if (!next) return reject(s, "stale");
      effects.push({ type: "init", turn: e.turn });
      return done(next, effects);
    }

    case "inited": {
      const next = setPending(e.turn, "READY", "INITED");
      if (!next) return reject(s, "stale");
      // 延長中に先頭の手番が INITED になったら、その時点で始める（run#A.5 の 6）
      const waiting =
        s.phase === "interlude" &&
        s.pending[0]?.turn.turn === e.turn &&
        s.timer?.name === "extension";
      return done(waiting ? advance(next, effects) : next, effects);
    }

    case "begin":
      if (s.phase !== "idle") return reject(s, "not_allowed");
      return done(arm({ ...s, phase: "interlude" }, "interlude", INTERLUDE_MS, effects), effects);

    case "end": {
      if (s.phase !== "running" && s.phase !== "resuming") return reject(s, "not_allowed");
      if (!s.current || s.current.turn.turn !== e.turn) return reject(s, "stale");
      const { turn } = s.current;
      // ミスはこの瞬間に、手元の閾値で決める。通信を待たない（run#A.5 の 1）
      const miss = isMiss({ via: e.via, score: e.score, missBelow: turn.missBelow });
      effects.push({
        type: "send_result",
        sessionId: turn.sessionId,
        turn: turn.turn,
        skipped: false,
        delayMs: 0,
      });
      const ended: RunHostState = {
        ...s,
        phase: "flash",
        current: { turn, frame: "ENDED" },
        lives: miss && s.lives > 0 ? s.lives - 1 : s.lives,
        last: { turn: turn.turn, via: e.via, score: e.score, miss },
        results: {
          ...s.results,
          [turn.sessionId]: { turn: turn.turn, skipped: false, failures: 0 },
        },
      };
      return done(arm(ended, "flash", FLASH_MS, effects), effects);
    }

    case "timer": {
      if (!s.timer || s.timer.id !== e.id) return reject(s, "stale");
      switch (s.timer.name) {
        case "flash":
          // 残機が尽きていれば幕間に進まない（run#A.5 の 3、F8）
          if (s.lives === 0) return done(close(s, effects), effects);
          return done(
            arm({ ...s, phase: "interlude" }, "interlude", INTERLUDE_MS, effects),
            effects,
          );
        case "interlude":
          return done(advance(s, effects), effects);
        case "extension":
          return done(skipLoad(s, effects), effects);
        case "resume": {
          if (!s.current) return reject(s, "stale");
          effects.push({ type: "resume", turn: s.current.turn.turn });
          const current: CurrentSlot = { turn: s.current.turn, frame: "RUNNING" };
          return done({ ...s, phase: "running", current, timer: null }, effects);
        }
      }
      return reject(s, "stale");
    }

    case "result_settled": {
      if (!(e.sessionId in s.results)) return reject(s, "stale");
      const { [e.sessionId]: _, ...results } = s.results;
      return done(settle({ ...s, results }, effects), effects);
    }

    case "result_failed": {
      const pending = s.results[e.sessionId];
      if (!pending) return reject(s, "stale");
      if (pending.failures >= RESULT_RETRIES) {
        // あきらめる。その手番はサーバで abandoned になる（run#A.7）
        const { [e.sessionId]: _, ...results } = s.results;
        return done(settle({ ...s, results }, effects), effects);
      }
      effects.push({
        type: "send_result",
        sessionId: e.sessionId,
        turn: pending.turn,
        skipped: pending.skipped,
        delayMs: RESULT_RETRY_MS,
      });
      const retried = { ...pending, failures: pending.failures + 1 };
      return done({ ...s, results: { ...s.results, [e.sessionId]: retried } }, effects);
    }

    case "hide": {
      if (s.hidden || over(s)) return reject(s, "not_allowed");
      const hidden = { ...s, hidden: true };
      if (s.current?.frame === "RUNNING" && (s.phase === "running" || s.phase === "resuming")) {
        effects.push({ type: "pause", turn: s.current.turn.turn });
        const current: CurrentSlot = { turn: s.current.turn, frame: "PAUSED" };
        return done({ ...hidden, phase: "running", current, timer: null }, effects);
      }
      if (s.phase === "resuming")
        return done({ ...hidden, phase: "running", timer: null }, effects);
      return done(hidden, effects);
    }

    case "show": {
      if (!s.hidden || over(s)) return reject(s, "not_allowed");
      const shown = { ...s, hidden: false };
      // 止めていた手番は「続きから」の幕間を出してから resume する
      if (s.current?.frame === "PAUSED") {
        return done(arm({ ...shown, phase: "resuming" }, "resume", INTERLUDE_MS, effects), effects);
      }
      // 非表示の間に幕間が終わっていたら、幕間を出し直す
      if (s.phase === "interlude" && s.timer === null && s.pending.length > 0) {
        return done(arm(shown, "interlude", INTERLUDE_MS, effects), effects);
      }
      return done(shown, effects);
    }

    case "abort":
      if (over(s)) return reject(s, "not_allowed");
      return done(close(s, effects), effects);
  }
}
