/**
 * ラン画面の配線（run#A.3〜A.9）。domain のラン Host（`runHostStep`）が返す effects を実行し、
 * 起きたことをイベントで戻す。進行の判断はここに置かない（すべて `packages/domain/src/run.ts`）。
 *
 * DOM に触らない。iframe への送信・時計・タイマー・API の呼び出しは `RunEnv` で受け取る。
 * 画面（`RunPage.tsx`）は `view` を描き、iframe から届いたメッセージと操作をここへ渡すだけ。
 *
 * - iframe 1 枚につき SDK の Host ブリッジ（`createHost`）を 1 つ持つ。セッションの検査
 *   （スキーマ、`end` の述語、監視タイマー）はブリッジと domain の状態機械がする
 * - 手番の `post_id`・`time_limit` は計画のその位置、seed は `turnSeed(ランの seed, 手番番号)`（run#A.3）
 * - 遊んだ結果の本文（`score` / `frames` / 入力ログ）は手番番号で持ち、`send_result` で送る
 */
import {
  type GameMeta,
  HIDDEN_ABORT_MS,
  type HostTurn,
  initialRunHost,
  type PlayedEnd,
  type RunHostEffect,
  type RunHostEvent,
  type RunHostState,
  runHostStep,
  turnSeed,
  unsettledTurns,
} from "@gamefeed/domain";
import { createHost, type Host, type HostToGuest } from "@gamefeed/sdk";
import { gameUrl } from "../game-url.ts";
import type { RunPlan, RunReport, TurnBody, TurnReply } from "./api.ts";

export interface RunEnv {
  /** 単調増加の実時間（ms） */
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** その番号の iframe の Guest へ送る。iframe がもう無ければ何もしない */
  post(iframe: number, message: HostToGuest): void;
  newSessionId(): string;
  /** `PUT /runs/{id}/turns/{turn}`。通信の失敗は `{kind: "failed"}` で返す（reject しない） */
  putTurn(turn: number, body: TurnBody): Promise<TurnReply>;
  /** `POST /runs/{id}/finish`。取れなければ null */
  finish(): Promise<RunReport | null>;
}

/** 画面に置く iframe 1 枚 */
export interface FrameView {
  /** iframe の番号。React の key と、メッセージの送り元の照合に使う */
  iframe: number;
  postId: string;
  src: string;
  /** 表示中の手番（スロット N）。それ以外は不可視で先読み中 */
  visible: boolean;
}

/** 結果フラッシュに出す値（run#A.5 の 2、A.10） */
export interface FlashView {
  via: PlayedEnd["via"];
  score: number | null;
  miss: boolean;
  /** 新作扱いの手番（偏差値の代わりに比を出し、「校正中」と添える） */
  isNew: boolean;
  /** サーバの応答。届いたら表示に足す。進行には使わない */
  deviation: number | null;
  ratio: number | null;
}

export type ReportState =
  /** まだ `finish` を呼んでいない */
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; report: RunReport }
  /** `finish` の応答が取れなかった。`retryFinish` で呼び直せる */
  | { kind: "failed" };

export interface RunView {
  run: RunHostState;
  frames: FrameView[];
  /** スタートの操作を受けられる（最初の手番が INITED。run#A.6） */
  startable: boolean;
  /** 次に出す手番（スロット N+1）のメタと周回。幕間に出す。まだ `ready` が届いていなければ meta は null */
  next: { meta: GameMeta | null; lap: number; turn: number } | null;
  /** 表示中の手番のメタ（「続きから」の幕間に出す） */
  current: GameMeta | null;
  flash: FlashView | null;
  report: ReportState;
  /** 終わった手番のうち、記録に入ったと確かめていない本数（run#A.7） */
  unsettled: number;
  /** 遊んだゲームの題名と動詞（`ready` で届いたもの）。成績表の科目欄に出す */
  titles: Readonly<Record<string, { title: string; verb: string }>>;
}

export interface RunController {
  readonly view: RunView;
  /** スタートの操作 */
  begin(): void;
  /** その番号の iframe から届いた生のメッセージ。送り元の照合は呼び出し側で済ませる */
  receive(iframe: number, raw: unknown): void;
  /** その iframe の `load` イベント。2 回目以降は iframe 自身の遷移なので破棄する（se#A.3） */
  frameLoaded(iframe: number): void;
  /** タブの表示・非表示（run#A.9）。非表示のまま 10 分で中断する */
  setHidden(hidden: boolean): void;
  /** 中断（run#A.9） */
  abort(): void;
  /** `finish` の応答が取れなかったときの呼び直し */
  retryFinish(): void;
  /** 画面を離れる。タイマーを止め、iframe をすべて破棄する。以後は何もしない */
  dispose(): void;
}

interface Frame {
  iframe: number;
  turn: HostTurn;
  postId: string;
  src: string;
  host: Host;
  loads: number;
  /** `ready` をラン Host に渡した */
  readied: boolean;
  /** この iframe の手番の終わりをラン Host に渡した */
  ended: boolean;
  /** ラン Host の `destroy` で外した */
  removed: boolean;
  /** ラン Host より先に死んだ（プロトコル違反、iframe の遷移）。画面からは外すが、スロットには残っている */
  dead: boolean;
}

export function createRunController(input: {
  plan: RunPlan;
  /** 配信オリジン（`VITE_GAMES_ORIGIN`） */
  gamesOrigin: string;
  env: RunEnv;
  onChange?: () => void;
}): RunController {
  const { plan, gamesOrigin, env } = input;
  const onChange = input.onChange ?? (() => {});

  const frames = new Map<number, Frame>();
  /** 遊んだ結果の本文。添字が手番番号 */
  const bodies = new Map<number, TurnBody>();
  /** 記録に入ったときの応答。添字が手番番号 */
  const replies = new Map<number, Extract<TurnReply, { kind: "settled" }>>();
  /** 始めた手番の山札の位置。添字が手番番号 */
  const startedIndex = new Map<number, number>();
  const titles: Record<string, { title: string; verb: string }> = {};
  const timers = new Set<unknown>();
  let visible: number | null = null;
  let report: ReportState = { kind: "none" };
  let hiddenTimer: unknown = null;
  let disposed = false;

  let state: RunHostState;
  let view: RunView;
  const queue: RunHostEvent[] = [];
  let busy = false;

  /** 後で 1 回だけ呼ぶ。`dispose` でまとめて止められるように持っておく */
  function later(cb: () => void, ms: number): unknown {
    const handle = env.setTimer(() => {
      timers.delete(handle);
      if (!disposed) cb();
    }, ms);
    timers.add(handle);
    return handle;
  }

  function cancel(handle: unknown): void {
    if (handle === null) return;
    timers.delete(handle);
    env.clearTimer(handle);
  }

  function metaOf(iframe: number | undefined): GameMeta | null {
    const s = iframe === undefined ? undefined : frames.get(iframe)?.host.state;
    return s && "meta" in s ? s.meta : null;
  }

  function flashOf(): FlashView | null {
    const last = state.last;
    if (!last) return null;
    const index = startedIndex.get(last.turn);
    const reply = replies.get(last.turn);
    return {
      via: last.via,
      score: last.score,
      miss: last.miss,
      isNew: index === undefined ? false : (plan.deck[index]?.is_new ?? false),
      deviation: reply?.deviation ?? null,
      ratio: reply?.ratio ?? null,
    };
  }

  function buildView(): RunView {
    const head = state.pending[0];
    return {
      run: state,
      frames: [...frames.values()]
        .filter((f) => !f.dead)
        .map((f) => ({
          iframe: f.iframe,
          postId: f.postId,
          src: f.src,
          visible: f.iframe === visible,
        })),
      startable: state.phase === "idle" && head?.frame === "INITED",
      next: head ? { meta: metaOf(head.iframe), lap: head.turn.lap, turn: head.turn.turn } : null,
      current: metaOf(state.current?.iframe),
      flash: flashOf(),
      report,
      unsettled: unsettledTurns(state),
      titles: { ...titles },
    };
  }

  function notify(): void {
    // effects の実行中は描かない。`dispatch` が終わりにまとめて知らせる
    if (disposed || busy) return;
    view = buildView();
    onChange();
  }

  /** ラン Host に 1 イベント通して、effects を実行する。実行の途中で起きたイベントは後ろに並べる */
  function dispatch(event: RunHostEvent): void {
    if (disposed) return;
    queue.push(event);
    if (busy) return;
    busy = true;
    try {
      for (let e = queue.shift(); e; e = queue.shift()) {
        const r = runHostStep(state, e);
        if (!r.ok) continue;
        state = r.state;
        for (const effect of r.effects) run(effect);
      }
    } finally {
      busy = false;
    }
    notify();
  }

  /** ラン Host より先に iframe が使えなくなった。画面から外し、表示中の手番なら `error` で終える（se#A.3） */
  function kill(f: Frame): void {
    if (f.removed || f.dead) return;
    f.dead = true;
    f.host.destroy();
    if (state.current?.iframe === f.iframe && !f.ended) {
      f.ended = true;
      dispatch({ type: "end", iframe: f.iframe, result: { via: "error" } });
    } else {
      // 先読み中なら、幕間の終わりに INITED でない手番として読み込みの skip になる。
      // INITED の後なら、`start` を送れないので `error` で終える（下の `start`）
      notify();
    }
  }

  /** iframe の Host ブリッジの状態が変わった */
  function frameChanged(f: Frame): void {
    if (disposed || f.removed) return;
    const s = f.host.state;
    if ("meta" in s) titles[f.postId] = { title: s.meta.title, verb: s.meta.verb };
    if (s.kind === "READY" && !f.readied) {
      f.readied = true;
      dispatch({ type: "ready", iframe: f.iframe });
    } else if (s.kind === "ENDED" && !f.ended) {
      f.ended = true;
      const r = s.result;
      if (r.via === "guest") {
        bodies.set(f.turn.turn, {
          via: "guest",
          score: r.score,
          frames: r.frames,
          inputs: [...f.host.inputs],
        });
        dispatch({ type: "end", iframe: f.iframe, result: { via: "guest", score: r.score } });
      } else {
        dispatch({ type: "end", iframe: f.iframe, result: { via: r.via } });
      }
    } else if (s.kind === "DESTROYED" && !f.dead) {
      // ブリッジが自分で破棄した（プロトコル違反。protocol#A.2）
      kill(f);
    }
  }

  function load(e: Extract<RunHostEffect, { type: "load" }>): void {
    const entry = plan.deck[e.index];
    if (!entry) throw new RangeError(`計画に山札の位置 ${e.index} がない`);
    const f: Frame = {
      iframe: e.iframe,
      turn: { turn: e.turn, index: e.index, lap: e.lap, speed: e.speed },
      postId: entry.post_id,
      src: gameUrl(gamesOrigin, entry.post_id),
      loads: 0,
      readied: false,
      ended: false,
      removed: false,
      dead: false,
      host: createHost(
        {
          post: (m) => env.post(e.iframe, m),
          now: () => env.now(),
          setTimer: (cb, ms) => later(cb, ms),
          clearTimer: (h) => cancel(h),
          newSessionId: () => env.newSessionId(),
          // 手番の seed は `init` に渡すので、ここは使われない
          newSeed: () => 0,
        },
        () => frameChanged(f),
      ),
    };
    frames.set(e.iframe, f);
  }

  function sendResult(turn: number, via: TurnBody["via"]): void {
    // 遊んだ結果は `end` のときに持っておいた本文。それ以外は値を持たない（sc#A.2）
    const body: TurnBody | undefined = via === "guest" ? bodies.get(turn) : { via };
    if (!body) throw new Error(`手番 ${turn} の遊んだ結果の本文がない`);
    env
      .putTurn(turn, body)
      .catch((): TurnReply => ({ kind: "failed" }))
      .then((reply) => {
        if (disposed) return;
        if (reply.kind === "settled") {
          replies.set(turn, reply);
          dispatch({ type: "result_settled", turn, settled: reply.settled });
        } else if (reply.kind === "out_of_order") {
          dispatch({ type: "result_out_of_order", turn, settled: reply.settled });
        } else if (reply.kind === "closed") {
          dispatch({ type: "result_closed", turn, settled: reply.settled });
        } else {
          dispatch({ type: "result_failed", turn });
        }
      });
  }

  function callFinish(): void {
    report = { kind: "loading" };
    env
      .finish()
      .catch(() => null)
      .then((r) => {
        if (disposed) return;
        report = r ? { kind: "ready", report: r } : { kind: "failed" };
        notify();
      });
  }

  function run(e: RunHostEffect): void {
    switch (e.type) {
      case "load":
        load(e);
        return;
      case "init": {
        const f = frames.get(e.iframe);
        const entry = f && plan.deck[f.turn.index];
        if (!f || !entry) return;
        const sent = f.host.init({
          speed: f.turn.speed,
          // 計画の値を入れる。Guest の `ready.duration` は使わない（run#A.3）
          timeLimit: entry.time_limit,
          seed: turnSeed(plan.seed, f.turn.turn),
        });
        if (sent) dispatch({ type: "inited", iframe: e.iframe });
        return;
      }
      case "start": {
        const f = frames.get(e.iframe);
        if (!f) return;
        visible = e.iframe;
        startedIndex.set(f.turn.turn, f.turn.index);
        if (!f.host.start() && !f.ended) {
          // INITED の後、`start` の前に死んだ iframe。始められないので `error` で終える
          f.ended = true;
          dispatch({ type: "end", iframe: e.iframe, result: { via: "error" } });
        }
        return;
      }
      case "pause":
        frames.get(e.iframe)?.host.pause();
        return;
      case "resume":
        frames.get(e.iframe)?.host.resume();
        return;
      case "destroy": {
        const f = frames.get(e.iframe);
        if (!f) return;
        f.removed = true;
        f.host.destroy();
        frames.delete(e.iframe);
        if (visible === e.iframe) visible = null;
        return;
      }
      case "timer":
        later(() => dispatch({ type: "timer", id: e.id }), e.ms);
        return;
      case "send_result":
        if (e.delayMs > 0) later(() => sendResult(e.turn, e.via), e.delayMs);
        else sendResult(e.turn, e.via);
        return;
      case "finish":
        callFinish();
        return;
    }
  }

  const initial = initialRunHost({
    mode: "endless",
    missBelow: plan.deck.map((d) => d.miss_below),
  });
  state = initial.state;
  for (const effect of initial.effects) run(effect);
  view = buildView();

  return {
    get view() {
      return view;
    },

    begin: () => dispatch({ type: "begin" }),

    receive(iframe, raw) {
      const f = frames.get(iframe);
      if (disposed || !f || f.removed || f.dead) return;
      f.host.receive(raw);
    },

    frameLoaded(iframe) {
      const f = frames.get(iframe);
      if (disposed || !f || f.removed || f.dead) return;
      f.loads += 1;
      if (f.loads > 1) kill(f);
    },

    setHidden(hidden) {
      if (disposed) return;
      cancel(hiddenTimer);
      hiddenTimer = null;
      const over = state.phase === "closing" || state.phase === "finished";
      if (hidden && !over) {
        hiddenTimer = later(() => {
          hiddenTimer = null;
          dispatch({ type: "abort" });
        }, HIDDEN_ABORT_MS);
      }
      dispatch({ type: hidden ? "hide" : "show" });
    },

    abort: () => dispatch({ type: "abort" }),

    retryFinish() {
      if (disposed || report.kind !== "failed") return;
      callFinish();
      notify();
    },

    dispose() {
      if (disposed) return;
      for (const f of frames.values()) {
        f.removed = true;
        f.host.destroy();
      }
      disposed = true;
      for (const h of timers) env.clearTimer(h);
      timers.clear();
      frames.clear();
    },
  };
}
