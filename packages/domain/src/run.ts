/**
 * ラン Host のスロット制御（run#A.4〜A.7、A.9）。ラン画面の頭脳。
 *
 * 純粋関数。DOM も通信もタイマーも持たない。iframe の生成・メッセージの送信・API の呼び出し・タイマーは
 * effects として返し、ラン画面が実行して結果をイベントで戻す。
 * 遷移の名前は `verification/Run.tla` と同じ語彙（Issue / Ready / Inited / Start / SkipLoad / End /
 * NoMoreTurns / Finish）で、コメントに対応を書く。
 *
 * - 進行は計画から決める（run#A.3）。手番の位置・周回・速度は `turnAt`、ミスは `outcomeOf`、
 *   ランの終わりは `logState`。どれもサーバが記録に対して使うのと同じ関数（F10、F12）
 * - スロットは N（表示中）と、次に出す 2 本（N+1、N+2）。生きている iframe は 3 枚以下（F3、F4）
 * - `start` を出すのは幕間の終わりの 1 か所で、INITED のスロットにだけ（F5）
 * - ミスは `end` の瞬間に計画の `miss_below` で判定する。通信を待たない（F8）
 * - 読み込みの skip は待たずに決める。最初の手番だけはスタート画面で 10 秒待つ（run#A.6）
 * - 結果は手番の順に 1 つずつ送り、記録に入るまで送り直す。サーバの応答で進行は変わらない（F11）
 * - ランが終わったら、遊んだ手番がすべて記録に入るか 10 秒経ってから `finish` を出す（run#A.7）
 * スタートの後の幕間・非表示の間の扱い・中断などは文書に無く、#161 の E の案で実装している。
 */

import { type LogEnd, logState, outcomeOf, type TurnOutcome, turnAt } from "./run-plan.ts";
import { ENDLESS_LIVES, type RunMode } from "./run-record.ts";
import type { Speed } from "./session.ts";
import type { TurnVia } from "./turn-result.ts";

/** 結果フラッシュの長さ（run#A.5 の 2。暫定） */
export const FLASH_MS = 500;
/** 幕間の長さ（run#A.5 の 4。暫定） */
export const INTERLUDE_MS = 1000;
/** スタート画面で最初の手番の INITED を待つ長さ（run#A.6。暫定） */
export const FIRST_LOAD_WAIT_MS = 10 * 1000;
/** 結果の送り直しの間隔。1 秒から倍にして最大 8 秒（run#A.7。暫定） */
export const RESULT_RETRY_MIN_MS = 1000;
export const RESULT_RETRY_MAX_MS = 8000;
/** ランが終わってから、結果が記録に入るのを待つ長さ。過ぎたらそのまま `finish`（run#A.7。暫定） */
export const FINISH_WAIT_MS = 10 * 1000;
/** 非表示のままこの時間が経ったら中断する（run#A.9。暫定）。計るのはラン画面で、`abort` を送る */
export const HIDDEN_ABORT_MS = 10 * 60 * 1000;
/** 先に用意しておく手番の数（スロット N+1、N+2） */
export const PREFETCH_SLOTS = 2;

/** 計画のうち、進行に使うもの（run#A.3）。`missBelow` は山札の位置ごとの閾値で、長さが山札の本数 */
export interface RunHostPlan {
  mode: RunMode;
  missBelow: readonly (number | null)[];
}

/** 計画から決まる手番の値。seed・`post_id`・`time_limit` はラン画面が `turn` と `index` から引く */
export interface HostTurn {
  turn: number;
  /** 山札の位置 */
  index: number;
  lap: number;
  speed: Speed;
}

/** 不可視スロットの iframe の状態（protocol#A.5 のうち、ランが区別するもの） */
export type PendingFrame = "LOADING" | "READY" | "INITED";

export interface PendingSlot {
  /** iframe の番号。作るたびに新しい値（同じ手番を作り直しても変わる） */
  iframe: number;
  turn: HostTurn;
  frame: PendingFrame;
}

/** 表示中の手番（スロット N） */
export interface CurrentSlot {
  iframe: number;
  turn: HostTurn;
  frame: "RUNNING" | "PAUSED" | "ENDED";
}

/** 表示中の手番の終わり方（sc#A.1 のうち、セッションが始まったもの） */
export type PlayedEnd = { via: "guest"; score: number } | { via: "timeout" } | { via: "error" };

export type RunPhase =
  /** スタート画面。最初の手番の INITED とスタートの操作を待っている。先読みは進む */
  | "idle"
  /** 手番 N が動いている（非表示で止めている間を含む） */
  | "running"
  /** 結果フラッシュ */
  | "flash"
  /** 幕間 */
  | "interlude"
  /** 表示に戻った後の「続きから」の幕間 */
  | "resuming"
  /** ランは終わった。結果が記録に入るのを待っている */
  | "closing"
  /** `finish` を出した */
  | "finished";

export type TimerName = "first" | "flash" | "interlude" | "resume" | "finish";

/** Host から見たランの終わり方。abandoned は中断（run#A.9） */
export type HostEnd = LogEnd | "abandoned";

export interface RunHostState {
  plan: RunHostPlan;
  phase: RunPhase;
  current: CurrentSlot | null;
  /** 次に出す手番。先頭が N+1 */
  pending: readonly PendingSlot[];
  /** 決まった手番の扱い。添字が手番番号（Host が見たラン。記録はこの先頭部分になる。F10） */
  outcomes: readonly TurnOutcome[];
  /** 決まった手番の結果の種類。添字が手番番号。送る本文はラン画面が手番番号で持つ */
  vias: readonly TurnVia[];
  /** 残機。デイリーは null（run#A.7） */
  lives: number | null;
  /** 読み込みの skip の本数（run#A.6） */
  loadSkips: number;
  /** ランが終わった理由。続いている間は null */
  ended: HostEnd | null;
  /** 直前に終わった手番の表示用の値（結果フラッシュ） */
  last: { turn: number; via: PlayedEnd["via"]; score: number | null; miss: boolean } | null;
  /** タブが非表示 */
  hidden: boolean;
  /** 動いているタイマー。イベントの id が違えば古いタイマーとして捨てる */
  timer: { id: number; name: TimerName } | null;
  timerSeq: number;
  iframeSeq: number;
  /** サーバの記録の長さとして最後に確かめた値（run#A.3 の `settled`） */
  settled: number;
  /** 送って応答を待っている手番。無ければ null。同時に送るのは 1 つ */
  sending: number | null;
  /** 次に送り直すときの待ち */
  retryMs: number;
  /** サーバが `run_closed` を返した。もう送らない（進行は変えない。F11） */
  serverClosed: boolean;
}

export type RunHostEvent =
  /** スタートの操作（「タップしてスタート」）。最初の手番が INITED のときだけ受ける */
  | { type: "begin" }
  /** 不可視スロットの Guest から `ready` が届いた（Ready） */
  | { type: "ready"; iframe: number }
  /** Host が `init` を送り終えた（Inited） */
  | { type: "inited"; iframe: number }
  /** 表示中の手番が終わった: `end`、監視タイマー満了、`error`（End） */
  | { type: "end"; iframe: number; result: PlayedEnd }
  | { type: "timer"; id: number }
  /** `PUT turns/{t}` に 200 が返った。settled は応答の値 */
  | { type: "result_settled"; turn: number; settled: number }
  /** 409 `out_of_order` が返った */
  | { type: "result_out_of_order"; turn: number; settled: number }
  /** 409 `run_closed` が返った */
  | { type: "result_closed"; turn: number; settled: number }
  /** 応答が来なかった（通信の失敗、ほかのステータス） */
  | { type: "result_failed"; turn: number }
  /** タブが非表示になった / 表示に戻った（run#A.9） */
  | { type: "hide" }
  | { type: "show" }
  /** 中断（非表示のまま HIDDEN_ABORT_MS、ユーザーの操作） */
  | { type: "abort" };

export type RunHostEffect =
  /** 不可視の iframe を作って、その手番のゲームを読み込む */
  | ({ type: "load"; iframe: number } & HostTurn)
  /** その iframe に `init` を送る */
  | { type: "init"; iframe: number }
  /** その iframe を表示して `start` を送る */
  | { type: "start"; iframe: number }
  | { type: "pause"; iframe: number }
  | { type: "resume"; iframe: number }
  /** `destroy` を送って iframe を外す */
  | { type: "destroy"; iframe: number }
  | { type: "timer"; id: number; name: TimerName; ms: number }
  /** delayMs の後に `PUT /runs/{id}/turns/{turn}` を送る。本文は via の形（sc#A.2） */
  | { type: "send_result"; turn: number; via: TurnVia; delayMs: number }
  /** `POST /runs/{id}/finish` を呼ぶ */
  | { type: "finish" };

export type RunHostReject =
  /** その phase では受けないイベント */
  | "not_allowed"
  /** 知らない iframe・手番、または古いタイマー */
  | "stale";

export type RunHostResult =
  | { ok: true; state: RunHostState; effects: RunHostEffect[] }
  | { ok: false; state: RunHostState; reason: RunHostReject };

const over = (s: RunHostState): boolean => s.phase === "closing" || s.phase === "finished";

/** 生きている iframe の数（F4） */
export function aliveFrames(s: RunHostState): number {
  return s.pending.length + (s.current ? 1 : 0);
}

/** 終わった手番のうち、まだ記録に入ったと確かめていない本数（成績表の「通信できなかった N 本」） */
export function unsettledTurns(s: RunHostState): number {
  return Math.max(0, s.outcomes.length - s.settled);
}

function arm(s: RunHostState, name: TimerName, ms: number, effects: RunHostEffect[]): RunHostState {
  const id = s.timerSeq + 1;
  effects.push({ type: "timer", id, name, ms });
  return { ...s, timer: { id, name }, timerSeq: id };
}

/** 表示中の手番がまだ決まっていなければ 1。次に出す手番の番号は `outcomes.length` にこれを足した値 */
const undecided = (s: RunHostState): number => (s.current && s.current.frame !== "ENDED" ? 1 : 0);

/**
 * スロット N+1、N+2 を計画どおりにそろえる（Issue。run#A.5 の 7、A.6）。
 * まだ決まっていない手番は成立したものとして位置を求める。先読み済みの手番が計画とずれたら
 * （前の手番が skip になって、その位置を飛ばすことになった）、捨てて作り直す。
 * 上限の手番より先と、出せる位置が無いときは作らない。
 */
function prefetch(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  const { mode, missBelow } = s.plan;
  const first = s.outcomes.length + undecided(s);
  const pending: PendingSlot[] = [];
  let iframeSeq = s.iframeSeq;
  let none = false;
  for (let j = 0; j < PREFETCH_SLOTS; j++) {
    const have = s.pending[j];
    const assumed: TurnOutcome[] = [...s.outcomes];
    while (assumed.length < first + j) assumed.push("ok");
    const at = none ? null : turnAt(mode, missBelow.length, assumed);
    if (!at || at.done) {
      none = true;
      if (have) effects.push({ type: "destroy", iframe: have.iframe });
      continue;
    }
    const same =
      have &&
      have.turn.turn === at.turn &&
      have.turn.index === at.index &&
      have.turn.lap === at.lap;
    if (have && same) {
      pending.push(have);
      continue;
    }
    if (have) effects.push({ type: "destroy", iframe: have.iframe });
    iframeSeq++;
    const turn: HostTurn = { turn: at.turn, index: at.index, lap: at.lap, speed: at.speed };
    effects.push({ type: "load", iframe: iframeSeq, ...turn });
    pending.push({ iframe: iframeSeq, turn, frame: "LOADING" });
  }
  return { ...s, pending, iframeSeq };
}

/** 記録にまだ無い最も古い手番を送る（run#A.7）。送っている途中なら何もしない */
function pump(s: RunHostState, delayMs: number, effects: RunHostEffect[]): RunHostState {
  if (s.sending !== null || s.serverClosed || s.phase === "finished") return s;
  const via = s.vias[s.settled];
  if (via === undefined) return s;
  effects.push({ type: "send_result", turn: s.settled, via, delayMs });
  return { ...s, sending: s.settled };
}

/** 手番の扱いが 1 つ決まった。記録の列に足して、送る */
function decide(
  s: RunHostState,
  via: TurnVia,
  outcome: TurnOutcome,
  effects: RunHostEffect[],
): RunHostState {
  const next: RunHostState = {
    ...s,
    outcomes: [...s.outcomes, outcome],
    vias: [...s.vias, via],
    lives: s.lives !== null && outcome === "miss" ? Math.max(0, s.lives - 1) : s.lives,
    loadSkips: s.loadSkips + (outcome === "noload" ? 1 : 0),
  };
  return pump(next, 0, effects);
}

/** Host が見たランが、記録の規則で終わっているか（run#A.3。サーバと同じ関数） */
const logEnd = (s: RunHostState): LogEnd | null =>
  logState(s.plan.mode, s.plan.missBelow.length, s.outcomes).ended;

/** 遊んだ手番がすべて記録に入った（またはサーバが閉じた）なら `finish` を出す */
function settle(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  if (s.phase !== "closing") return s;
  if (!s.serverClosed && s.settled < s.outcomes.length) return s;
  effects.push({ type: "finish" });
  return { ...s, phase: "finished", timer: null };
}

/**
 * ランを終える（Finish）。iframe をすべて外し、結果が記録に入るのを 10 秒まで待つ（run#A.7）。
 * 表示中の手番がまだ終わっていなければ、結果を送らずに捨てる（run#A.9）
 */
function close(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  for (const slot of [...(s.current ? [s.current] : []), ...s.pending]) {
    effects.push({ type: "destroy", iframe: slot.iframe });
  }
  const closing: RunHostState = {
    ...s,
    phase: "closing",
    ended: logEnd(s) ?? "abandoned",
    current: null,
    pending: [],
    timer: null,
  };
  const settled = settle(closing, effects);
  return settled.phase === "finished" ? settled : arm(settled, "finish", FINISH_WAIT_MS, effects);
}

/** 先頭の手番を読み込みの skip にする（SkipLoad。run#A.5 の 6、A.6）。次をどうするかは呼び出し側 */
function skipLoad(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  const head = s.pending[0];
  if (!head) return s;
  effects.push({ type: "destroy", iframe: head.iframe });
  return decide({ ...s, pending: s.pending.slice(1) }, "noload", "noload", effects);
}

/**
 * スタート画面の待ち（run#A.6）。最初の手番が INITED でなければ 10 秒を計る。
 * 非表示の間は計らない（表示に戻ったときに計り直す）
 */
function awaitFirst(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  const head = s.pending[0];
  if (!head || head.frame === "INITED" || s.hidden) return { ...s, timer: null };
  return arm(s, "first", FIRST_LOAD_WAIT_MS, effects);
}

/**
 * 幕間の終わり（run#A.5 の 5〜6）。先頭の手番が INITED なら `start`（Start）、まだなら待たずに
 * 読み込みの skip にして幕間からやり直す。3 本目の読み込みの skip か、出せる手番が無ければランを終える。
 */
function advance(s: RunHostState, effects: RunHostEffect[]): RunHostState {
  // 非表示の間は始めず、読み込みの skip も決めない。表示に戻ったら幕間を出し直す（run#A.9）
  if (s.hidden) return { ...s, timer: null };
  const head = s.pending[0];
  // 続いているランには次の手番がある。無いのは終わっているとき（NoMoreTurns）
  if (!head) return close(s, effects);
  if (head.frame !== "INITED") {
    const skipped = skipLoad(s, effects);
    if (logEnd(skipped) !== null) return close(skipped, effects);
    return arm(prefetch(skipped, effects), "interlude", INTERLUDE_MS, effects);
  }
  effects.push({ type: "start", iframe: head.iframe });
  if (s.current) effects.push({ type: "destroy", iframe: s.current.iframe });
  const started: RunHostState = {
    ...s,
    phase: "running",
    current: { iframe: head.iframe, turn: head.turn, frame: "RUNNING" },
    pending: s.pending.slice(1),
    timer: null,
  };
  return prefetch(started, effects);
}

/** ランの始まり。スロット N+1、N+2 にあたる 2 手番を読み込み、最初の手番の INITED を 10 秒待つ */
export function initialRunHost(plan: RunHostPlan): {
  state: RunHostState;
  effects: RunHostEffect[];
} {
  if (plan.missBelow.length < 1) throw new RangeError("deck is empty");
  const effects: RunHostEffect[] = [];
  const empty: RunHostState = {
    plan,
    phase: "idle",
    current: null,
    pending: [],
    outcomes: [],
    vias: [],
    lives: plan.mode === "endless" ? ENDLESS_LIVES : null,
    loadSkips: 0,
    ended: null,
    last: null,
    hidden: false,
    timer: null,
    timerSeq: 0,
    iframeSeq: 0,
    settled: 0,
    sending: null,
    retryMs: RESULT_RETRY_MIN_MS,
    serverClosed: false,
  };
  return { state: awaitFirst(prefetch(empty, effects), effects), effects };
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
 * ランが終わった後に届いた `ready` などは捨てる。
 */
export function runHostStep(s: RunHostState, e: RunHostEvent): RunHostResult {
  const effects: RunHostEffect[] = [];
  const setPending = (
    iframe: number,
    from: PendingFrame,
    to: PendingFrame,
  ): RunHostState | null => {
    const i = s.pending.findIndex((p) => p.iframe === iframe);
    if (i < 0 || s.pending[i]?.frame !== from) return null;
    return { ...s, pending: s.pending.map((p, j) => (j === i ? { ...p, frame: to } : p)) };
  };

  switch (e.type) {
    case "ready": {
      const next = setPending(e.iframe, "LOADING", "READY");
      if (!next) return reject(s, "stale");
      effects.push({ type: "init", iframe: e.iframe });
      return done(next, effects);
    }

    case "inited": {
      const next = setPending(e.iframe, "READY", "INITED");
      if (!next) return reject(s, "stale");
      // スタート画面で待っていた最初の手番が間に合った。10 秒の待ちをやめる
      const first = s.phase === "idle" && s.pending[0]?.iframe === e.iframe;
      return done(first ? { ...next, timer: null } : next, effects);
    }

    case "begin":
      // スタートの操作は最初の手番が INITED になってから受け付ける（run#A.6）
      if (s.phase !== "idle" || s.pending[0]?.frame !== "INITED") return reject(s, "not_allowed");
      return done(arm({ ...s, phase: "interlude" }, "interlude", INTERLUDE_MS, effects), effects);

    case "end": {
      if (s.phase !== "running" && s.phase !== "resuming") return reject(s, "not_allowed");
      if (!s.current || s.current.iframe !== e.iframe) return reject(s, "stale");
      const { turn } = s.current;
      // 扱いはこの瞬間に、計画の閾値で決める。通信を待たない（run#A.5 の 1）
      const outcome = outcomeOf(e.result, s.plan.missBelow[turn.index] ?? null);
      const ended = decide(
        {
          ...s,
          phase: "flash",
          current: { ...s.current, frame: "ENDED" },
          last: {
            turn: turn.turn,
            via: e.result.via,
            score: e.result.via === "guest" ? e.result.score : null,
            miss: outcome === "miss",
          },
        },
        e.result.via,
        outcome,
        effects,
      );
      // ランが終わっていれば先読みは触らない（フラッシュの後にまとめて外す）。
      // 続くなら、skip で飛ばすことになった位置の先読みをここで作り直す（run#A.6）
      const next = logEnd(ended) === null ? prefetch(ended, effects) : ended;
      return done(arm(next, "flash", FLASH_MS, effects), effects);
    }

    case "timer": {
      if (!s.timer || s.timer.id !== e.id) return reject(s, "stale");
      switch (s.timer.name) {
        case "first": {
          // 非表示の間は読み込みの skip を決めない。表示に戻ったら計り直す
          if (s.hidden || s.pending[0]?.frame === "INITED") {
            return done({ ...s, timer: null }, effects);
          }
          const skipped = skipLoad(s, effects);
          if (logEnd(skipped) !== null) return done(close(skipped, effects), effects);
          // 次の手番を最初の手番として、同じように待つ
          return done(awaitFirst(prefetch(skipped, effects), effects), effects);
        }
        case "flash":
          // ランが終わっていれば幕間に進まない（run#A.5 の 3、F8）。非表示の間でも終える
          if (logEnd(s) !== null) return done(close(s, effects), effects);
          return done(
            arm({ ...s, phase: "interlude" }, "interlude", INTERLUDE_MS, effects),
            effects,
          );
        case "interlude":
          return done(advance(s, effects), effects);
        case "resume": {
          if (!s.current) return reject(s, "stale");
          effects.push({ type: "resume", iframe: s.current.iframe });
          const current: CurrentSlot = { ...s.current, frame: "RUNNING" };
          return done({ ...s, phase: "running", current, timer: null }, effects);
        }
        case "finish":
          // 10 秒待っても記録に入らなかった。そのまま呼ぶ（run#A.7）
          effects.push({ type: "finish" });
          return done({ ...s, phase: "finished", timer: null }, effects);
      }
      return reject(s, "stale");
    }

    case "result_settled":
    case "result_out_of_order":
    case "result_closed":
    case "result_failed": {
      if (s.phase === "finished" || s.sending !== e.turn) return reject(s, "stale");
      const free: RunHostState = { ...s, sending: null };
      if (e.type === "result_closed") {
        // サーバが記録を閉じた（期限など）。もう足されないので送らない。進行は変えない（F11）
        return done(settle({ ...free, serverClosed: true }, effects), effects);
      }
      // 応答の settled を正とする。応答が無ければ手元で最後に確かめた値のまま（run#A.7）
      const reported = e.type === "result_failed" ? s.settled : e.settled;
      const settled = Math.min(s.outcomes.length, Math.max(0, Math.trunc(reported)));
      const progressed = e.type === "result_settled" && settled > s.settled;
      if (progressed) {
        const next = settle({ ...free, settled, retryMs: RESULT_RETRY_MIN_MS }, effects);
        return done(pump(next, 0, effects), effects);
      }
      // 応答なし・`out_of_order`: settled の手番から、間隔を倍にしながら送り直す
      const retried: RunHostState = {
        ...free,
        settled,
        retryMs: Math.min(RESULT_RETRY_MAX_MS, s.retryMs * 2),
      };
      return done(pump(settle(retried, effects), s.retryMs, effects), effects);
    }

    case "hide": {
      if (s.hidden || over(s)) return reject(s, "not_allowed");
      const hidden = { ...s, hidden: true };
      if (s.current?.frame === "RUNNING" && (s.phase === "running" || s.phase === "resuming")) {
        effects.push({ type: "pause", iframe: s.current.iframe });
        const current: CurrentSlot = { ...s.current, frame: "PAUSED" };
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
      if (s.phase === "interlude" && s.timer === null) {
        return done(arm(shown, "interlude", INTERLUDE_MS, effects), effects);
      }
      // 非表示の間にスタート画面の待ちが切れていたら、計り直す
      if (s.phase === "idle" && s.timer === null) return done(awaitFirst(shown, effects), effects);
      return done(shown, effects);
    }

    case "abort":
      if (over(s)) return reject(s, "not_allowed");
      return done(close(s, effects), effects);
  }
}
