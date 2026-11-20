// 単発プレイの配線（run#A.12、A.14、se#A.3）。試遊ページとゲームページが同じ部品を使う。
// iframe の中身は SDK の Guest ランタイムをメモリ上でつなぐ。時計はテストが進める。
import type { GameMeta } from "@gamefeed/domain";
import { createGuest, type Guest, type HostToGuest } from "@gamefeed/sdk";
import { describe, expect, it } from "vitest";
import { createSinglePlayer, READY_TIMEOUT_MS } from "../src/single/player.ts";

const META: GameMeta = {
  title: "まるタップ",
  verb: "タップ！",
  input: "tap",
  duration: 180,
  target: 10,
};
const STEP_MS = 1000 / 60;

function setup(opts: { score?: number; game?: (guest: Guest) => void } = {}) {
  const clock = { t: 0 };
  const timers: { at: number; cb: () => void }[] = [];
  const sent: HostToGuest[] = [];
  let guest: Guest | null = null;
  let changes = 0;
  let sessions = 0;
  let seeds = 0;

  const player = createSinglePlayer({
    env: {
      post: (m) => {
        sent.push(m);
        guest?.receive(m);
      },
      now: () => clock.t,
      setTimer: (cb, ms) => {
        const timer = { at: clock.t + ms, cb };
        timers.push(timer);
        return timer;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
      newSessionId: () => `s-${++sessions}`,
      newSeed: () => 1000 + ++seeds,
    },
    onChange: () => changes++,
  });

  /** iframe が読み込まれ、ゲームが ready を送る */
  function load(): Guest {
    player.frameLoaded();
    const g = createGuest({ post: (m) => player.receive(m), now: () => clock.t });
    g.GF.onInit(() => {
      g.GF.score = opts.score ?? 7;
    });
    opts.game?.(g);
    guest = g;
    g.ready(META);
    return g;
  }

  function advance(ms: number): void {
    const until = clock.t + ms;
    while (clock.t < until - 1e-6) {
      clock.t = Math.min(until, clock.t + STEP_MS);
      guest?.frame();
      for (;;) {
        // 満了時刻より前に呼ぶと、状態機械が監視タイマーの満了を捨てる（誤差を足さない）
        const i = timers.findIndex((t) => t.at <= clock.t);
        if (i < 0) break;
        timers.splice(i, 1)[0]?.cb();
      }
    }
  }

  return { player, sent, load, advance, changes: () => changes };
}

describe("createSinglePlayer（iframe 1 枚で 1 本だけ遊ぶ）", () => {
  it("R-run.A14-1 ready が届いたらすぐ init する（等速、time_limit は ready.duration、seed は新しく引く）。start はタップを待つ", () => {
    const { player, sent, load } = setup();
    expect(player.state.kind).toBe("LOADING");
    expect(player.meta).toBeNull();

    load();
    expect(player.state.kind).toBe("INITED");
    expect(player.meta).toEqual(META);
    expect(sent).toEqual([
      { type: "init", session_id: "s-1", seed: 1001, mode: "play", time_limit: 180, speed: 1 },
    ]);
  });

  it("R-run.A14-1 start で走り、ゲームが終わると結果を持つ。「もう一回」は同じ iframe に init し直す（pr#A.6）", () => {
    const { player, sent, load, advance } = setup({ score: 12 });
    load();
    player.start();
    expect(player.state.kind).toBe("RUNNING");
    expect(player.result).toBeNull();

    advance(3100);
    expect(player.state.kind).toBe("ENDED");
    expect(player.result).toMatchObject({ via: "guest", score: 12, frames: 180 });

    player.again();
    expect(player.state.kind).toBe("INITED");
    expect(player.result).toBeNull();
    expect(sent.map((m) => m.type)).toEqual(["init", "start", "init"]);
    // 遊ぶたびに新しいセッションと seed
    expect(sent[2]).toMatchObject({ session_id: "s-2", seed: 1002 });

    player.start();
    advance(3100);
    expect(player.result).toMatchObject({ via: "guest", score: 12 });
  });

  it("start と again は効く状態でだけ効く（LOADING の start、RUNNING の again は何もしない）", () => {
    const { player, sent, load } = setup();
    player.start();
    player.again();
    expect(sent).toEqual([]);
    load();
    player.again();
    player.start();
    player.again();
    expect(sent.map((m) => m.type)).toEqual(["init", "start"]);
    expect(player.state.kind).toBe("RUNNING");
  });

  it("ゲームが end を送らずに固まったら、監視タイマーで時間切れになる（pr#A.7）", () => {
    const { player, load, advance } = setup({
      game: (g) => {
        // 固まったゲーム: 描画のタイミングが来ても何も進まない
        g.frame = () => {};
      },
    });
    load();
    player.start();
    advance(3000 + 1500 + 100);
    expect(player.state.kind).toBe("ENDED");
    expect(player.result).toMatchObject({ via: "timeout" });
  });

  it("R-run.A14-2 読み込めたのに ready が届かなければ、待ち続けずに破棄する（配信が 404 の投稿）", () => {
    const { player, sent, advance } = setup();
    player.frameLoaded();
    advance(READY_TIMEOUT_MS - 100);
    expect(player.state.kind).toBe("LOADING");
    expect(player.halted).toBeNull();

    advance(200);
    expect(player.state.kind).toBe("DESTROYED");
    expect(player.halted).toBe("no_ready");
    expect(sent).toEqual([{ type: "destroy" }]);
  });

  it("ready が間に合えば、その後に時間が過ぎても破棄しない", () => {
    const { player, load, advance } = setup();
    load();
    advance(READY_TIMEOUT_MS + 1000);
    expect(player.state.kind).toBe("INITED");
    expect(player.halted).toBeNull();
  });

  it("2 回目の load は iframe 自身の遷移なので、すぐ破棄する（se#A.3）", () => {
    const { player, sent, load } = setup();
    load();
    player.start();
    player.frameLoaded();
    expect(player.state.kind).toBe("DESTROYED");
    expect(player.halted).toBe("navigated");
    expect(sent.at(-1)).toEqual({ type: "destroy" });
    // 破棄した後に届いたものは捨てる。メタは診断のために残す
    player.receive({ type: "end", score: 1, frames: 1 });
    expect(player.state.kind).toBe("DESTROYED");
    expect(player.meta).toEqual(META);
  });

  it("スキーマ違反のメッセージは破棄し、理由を problem に持つ（pr#A.2）", () => {
    const { player, load } = setup();
    load();
    player.receive({ type: "nope" });
    expect(player.state.kind).toBe("DESTROYED");
    expect(player.halted).toBeNull();
    expect(player.problem).toMatch(/^プロトコル違反/);
  });

  it("状態が変わるたびに onChange を呼ぶ", () => {
    const { player, load, changes } = setup();
    const before = changes();
    load();
    expect(changes()).toBeGreaterThan(before);
    const inited = changes();
    player.start();
    expect(changes()).toBeGreaterThan(inited);
  });
});
