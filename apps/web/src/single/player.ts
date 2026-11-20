// iframe 1 枚で 1 本だけ遊ぶ Host の配線（run#A.12 の試遊ページ、run#A.14 のゲームページ）。
// DOM に触らない。iframe への送信・時計・タイマーは `HostEnv` で受け、iframe の `load` と
// Guest のメッセージは呼び出し側が `frameLoaded` / `receive` で伝える。
import type { GameMeta, SessionResult, SessionState, Speed } from "@gamefeed/domain";
import { createHost, type HostEnv, type InputLogEntry } from "@gamefeed/sdk";

/** 最初の load から ready までに待つ時間（ms）。過ぎたら読み込めなかったものとして破棄する */
export const READY_TIMEOUT_MS = 5000;

/**
 * Host の側で iframe を破棄した理由。
 * - `navigated`: 2 回目以降の `load`。iframe 自身の遷移（se#A.3）
 * - `no_ready`: 読み込めたのに `ready` が届かない（配信が 404、SDK より前の例外）
 */
export type Halt = "navigated" | "no_ready";

export interface SinglePlayer {
  readonly state: SessionState;
  /** 最後に届いたメタ宣言。破棄した後も残す */
  readonly meta: GameMeta | null;
  /** 直近のセッションの結果。終わっていなければ null */
  readonly result: SessionResult | null;
  /** 現在のセッションで受理した入力ログ */
  readonly inputs: readonly InputLogEntry[];
  /** Guest の `error.message`、またはプロトコル違反の理由 */
  readonly problem: string | null;
  readonly halted: Halt | null;
  /** iframe の `load` イベント */
  frameLoaded(): void;
  /** Guest から届いた生のメッセージ。送り元の照合は呼び出し側で済ませる（pr#A.1） */
  receive(raw: unknown): void;
  /** 「タップしてスタート」 */
  start(): void;
  /** 「もう一回」。同じ iframe に `init` し直す（pr#A.6） */
  again(): void;
}

export function createSinglePlayer(opts: {
  env: HostEnv;
  /** 既定は等速 */
  speed?: Speed;
  onChange: () => void;
}): SinglePlayer {
  const { env, onChange } = opts;
  const speed: Speed = opts.speed ?? 1;
  const host = createHost(env, onChange);
  let meta: GameMeta | null = null;
  let halted: Halt | null = null;
  let loads = 0;

  function halt(reason: Halt): void {
    halted = reason;
    host.destroy();
    onChange();
  }

  return {
    get state() {
      return host.state;
    },
    get meta() {
      return meta;
    },
    get result() {
      return host.state.kind === "ENDED" ? host.state.result : null;
    },
    get inputs() {
      return host.inputs;
    },
    get problem() {
      return host.problem;
    },
    get halted() {
      return halted;
    },

    frameLoaded() {
      loads += 1;
      // 2 回目以降の load は iframe 自身の遷移。即座に破棄する（se#A.3）
      if (loads > 1) {
        if (host.state.kind !== "DESTROYED") halt("navigated");
        return;
      }
      // 読み込めたのに ready が届かないなら、待ち続けない
      env.setTimer(() => {
        if (host.state.kind === "LOADING") halt("no_ready");
      }, READY_TIMEOUT_MS);
    },

    receive(raw) {
      host.receive(raw);
      if ("meta" in host.state) meta = host.state.meta;
      // ready が届いたら、すぐ遊べるように準備しておく
      if (host.state.kind === "READY") host.init({ speed });
    },

    start() {
      host.start();
    },

    again() {
      if (host.state.kind === "ENDED") host.init({ speed });
    },
  };
}
