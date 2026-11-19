// ラン画面の配線（run#A.3〜A.9、se#A.3）。iframe の中身は SDK の Guest ランタイムをメモリ上でつなぎ、
// サーバは記録の規則（手番の順にしか足さない。run#A.3）だけを持つ代役にする。
// 進行の規則そのものは `packages/domain/test/run.spec.ts` が見る。ここは「effects を正しく実行するか」。
import {
  FINISH_WAIT_MS,
  FIRST_LOAD_WAIT_MS,
  FLASH_MS,
  type GameMeta,
  HIDDEN_ABORT_MS,
  INTERLUDE_MS,
  turnSeed,
} from "@gamefeed/domain";
import { createGuest, type Guest, type HostToGuest } from "@gamefeed/sdk";
import { describe, expect, it } from "vitest";
import type { RunPlan, RunReport, TurnBody, TurnReply } from "../src/run/api.ts";
import { createRunController, type RunController } from "../src/run/controller.ts";

const ORIGIN = "https://games.example.workers.dev";
const POSTS = [
  "01M782MV00TMYMTHTGG5C6KS3A",
  "01M782MV00TMYMTHTGG5C6KS3B",
  "01M782MV00TMYMTHTGG5C6KS3C",
] as const;
/** 1 手番 = 60 フレーム（等速で 1 秒） */
const TIME_LIMIT = 60;
const STEP_MS = 1000 / 60;

const meta = (postId: string): GameMeta => ({
  title: `ゲーム ${postId.slice(-1)}`,
  verb: "タップ！",
  input: "tap",
  // 計画の time_limit と違う値。Host はこれを使わない（run#A.3）
  duration: 180,
  target: 10,
});

function planOf(missBelow: (number | null)[] = [null, null, null]): RunPlan {
  return {
    runId: "01M782MV00TMYMTHTGG5C6KS3R",
    seed: 123456789,
    deck: missBelow.map((m, i) => ({
      post_id: POSTS[i] as string,
      is_new: m === null,
      miss_below: m,
      time_limit: TIME_LIMIT,
    })),
  };
}

interface Options {
  plan?: RunPlan;
  /** ゲームが出す点。既定は 5 */
  score?: (postId: string) => number;
  /** 読み込めない投稿（`ready` が届かない） */
  unloadable?: (postId: string) => boolean;
  /** Guest の振る舞いを足す */
  game?: (guest: Guest, postId: string) => void;
}

function setup(opts: Options = {}) {
  const plan = opts.plan ?? planOf();
  const clock = { t: 0 };
  const timers: { at: number; cb: () => void }[] = [];
  const guests = new Map<number, Guest>();
  const sent = new Map<number, HostToGuest[]>();
  const server = {
    settled: 0,
    closed: false,
    offline: false,
    puts: [] as { turn: number; body: TurnBody }[],
    finishes: 0,
    report: null as RunReport | null,
  };
  let changes = 0;
  let sessions = 0;
  let maxFrames = 0;

  const ctl: RunController = createRunController({
    plan,
    gamesOrigin: ORIGIN,
    env: {
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
      post: (iframe, m) => {
        sent.set(iframe, [...(sent.get(iframe) ?? []), m]);
        guests.get(iframe)?.receive(m);
      },
      newSessionId: () => `s-${++sessions}`,
      putTurn: async (turn, body): Promise<TurnReply> => {
        server.puts.push({ turn, body });
        if (server.offline) return { kind: "failed" };
        const reply = { deviation: 50, miss: false, ratio: null };
        if (turn < server.settled) return { kind: "settled", settled: server.settled, ...reply };
        if (server.closed) return { kind: "closed", settled: server.settled };
        if (turn > server.settled) return { kind: "out_of_order", settled: server.settled };
        server.settled += 1;
        return { kind: "settled", settled: server.settled, ...reply };
      },
      finish: async () => {
        server.finishes += 1;
        if (server.offline) return null;
        server.closed = true;
        server.report = {
          run_id: plan.runId,
          mode: "endless",
          ended: "abandoned",
          reached: server.settled,
          avg_deviation: null,
          symbols: null,
          turns: [],
        };
        return server.report;
      },
    },
    onChange: () => changes++,
  });

  /** ブラウザの代わり: 画面に出た iframe を読み込み、外れた iframe を捨てる */
  function browser(): void {
    const shown = new Set(ctl.view.frames.map((f) => f.iframe));
    maxFrames = Math.max(maxFrames, shown.size);
    for (const iframe of guests.keys()) if (!shown.has(iframe)) guests.delete(iframe);
    for (const f of ctl.view.frames) {
      if (guests.has(f.iframe) || sent.has(-f.iframe)) continue;
      sent.set(-f.iframe, []); // 読み込みを始めた印（同じ iframe を 2 度読み込まない）
      ctl.frameLoaded(f.iframe);
      if (opts.unloadable?.(f.postId)) continue;
      const guest = createGuest({ post: (m) => ctl.receive(f.iframe, m), now: () => clock.t });
      const score = opts.score?.(f.postId) ?? 5;
      guest.GF.onInit(() => {
        guest.GF.score = score;
      });
      opts.game?.(guest, f.postId);
      guests.set(f.iframe, guest);
      guest.ready(meta(f.postId));
    }
  }

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  /** 実時間を進める。Guest の描画、タイマー、通信の応答を動かす */
  async function advance(ms: number, stepMs = STEP_MS): Promise<void> {
    const until = clock.t + ms;
    browser();
    await flush();
    while (clock.t < until - 1e-6) {
      clock.t = Math.min(until, clock.t + stepMs);
      for (const guest of [...guests.values()]) guest.frame();
      for (let due = nextDue(); due; due = nextDue()) due.cb();
      await flush();
      browser();
      await flush();
    }
  }
  function nextDue() {
    const i = timers.findIndex((t) => t.at <= clock.t + 1e-6);
    return i >= 0 ? timers.splice(i, 1)[0] : undefined;
  }

  /** スタート画面から最初の手番が走り出すまで */
  async function start(): Promise<void> {
    await advance(0);
    expect(ctl.view.startable).toBe(true);
    ctl.begin();
    await advance(INTERLUDE_MS);
    expect(ctl.view.run.phase).toBe("running");
  }

  /** 1 手番ぶん（幕間の終わりから次の幕間の終わりまで）。等速のとき */
  const TURN_MS = 1000 + FLASH_MS + INTERLUDE_MS;

  return {
    ctl,
    plan,
    server,
    sent,
    guests,
    timers,
    advance,
    start,
    TURN_MS,
    changes: () => changes,
    maxFrames: () => maxFrames,
    visible: () => ctl.view.frames.filter((f) => f.visible),
  };
}

describe("先読みと最初の手番（run#A.3、A.4、A.6）", () => {
  it("R-8.2-3 計画の最初の 2 手番を不可視の iframe で読み込む。URL は gameUrl、init は計画の time_limit・手番の seed・周回の速度", async () => {
    const { ctl, plan, sent, advance } = setup();
    expect(ctl.view.frames).toEqual([
      { iframe: 1, postId: POSTS[0], src: `${ORIGIN}/p/${POSTS[0]}/`, visible: false },
      { iframe: 2, postId: POSTS[1], src: `${ORIGIN}/p/${POSTS[1]}/`, visible: false },
    ]);
    expect(ctl.view.startable).toBe(false);

    await advance(0);
    expect(sent.get(1)).toEqual([
      {
        type: "init",
        session_id: "s-1",
        seed: turnSeed(plan.seed, 0),
        mode: "play",
        time_limit: TIME_LIMIT,
        speed: 1,
      },
    ]);
    expect(sent.get(2)?.[0]).toMatchObject({
      seed: turnSeed(plan.seed, 1),
      time_limit: TIME_LIMIT,
    });
    expect(ctl.view.startable).toBe(true);
    expect(ctl.view.next).toMatchObject({ meta: { verb: "タップ！" }, lap: 0, turn: 0 });
    // start はまだ送っていない（F5）
    expect(sent.get(1)?.some((m) => m.type === "start")).toBe(false);
  });

  it("スタートの操作は最初の手番が INITED になるまで受けない（run#A.6）", async () => {
    const { ctl, advance } = setup();
    ctl.begin();
    expect(ctl.view.run.phase).toBe("idle");
    await advance(0);
    ctl.begin();
    expect(ctl.view.run.phase).toBe("interlude");
  });

  it("R-run.A6-1 読み込めない手番はスタート画面で 10 秒待って読み込みの skip。3 本で通信エラーになり、成績表でなく ended = error", async () => {
    const { ctl, server, advance, visible } = setup({ unloadable: () => true });
    await advance(FIRST_LOAD_WAIT_MS - 100, 100);
    expect(ctl.view.run.loadSkips).toBe(0);
    await advance(200, 100);
    expect(ctl.view.run.loadSkips).toBe(1);
    expect(server.puts[0]).toEqual({ turn: 0, body: { via: "noload" } });

    await advance(2 * FIRST_LOAD_WAIT_MS, 100);
    expect(ctl.view.run).toMatchObject({ loadSkips: 3, ended: "error", phase: "finished" });
    expect(server.puts.map((p) => p.body)).toEqual([
      { via: "noload" },
      { via: "noload" },
      { via: "noload" },
    ]);
    expect(server.finishes).toBe(1);
    expect(ctl.view.frames).toEqual([]);
    expect(visible()).toEqual([]);
  });
});

describe("手番の切り替え（run#A.5、A.7）", () => {
  it("R-8.2-3 スタート → 幕間 1 秒 → start。表示中は 1 枚で、iframe は 3 枚を超えない", async () => {
    const { ctl, sent, start, visible, maxFrames } = setup();
    await start();
    expect(sent.get(1)?.map((m) => m.type)).toEqual(["init", "start"]);
    expect(visible().map((f) => f.iframe)).toEqual([1]);
    // 始めたら、次の 2 手番が先読みされている
    expect(ctl.view.frames.map((f) => [f.iframe, f.postId])).toEqual([
      [1, POSTS[0]],
      [2, POSTS[1]],
      [3, POSTS[2]],
    ]);
    expect(maxFrames()).toBeLessThanOrEqual(3);
  });

  it("end で結果フラッシュ、0.5 秒で幕間、1 秒で次の start。遊んだ結果を {via: guest, score, frames, inputs} で送り、応答の偏差値をフラッシュに足す", async () => {
    const { ctl, server, sent, start, advance, visible } = setup({
      game: (guest) => {
        guest.GF.onTick((f) => {
          if (f === 10) guest.input("tap", [0.5, 0.5]);
        });
      },
    });
    await start();
    await advance(1000 + 50);
    expect(ctl.view.run.phase).toBe("flash");
    expect(server.puts).toEqual([
      {
        turn: 0,
        body: { via: "guest", score: 5, frames: TIME_LIMIT, inputs: [[11, "tap", 0.5, 0.5]] },
      },
    ]);
    expect(ctl.view.flash).toEqual({
      via: "guest",
      score: 5,
      miss: false,
      isNew: true,
      deviation: 50,
      ratio: null,
    });
    // フラッシュの間は終わった手番の iframe が下に残る
    expect(visible().map((f) => f.iframe)).toEqual([1]);

    await advance(FLASH_MS);
    expect(ctl.view.run.phase).toBe("interlude");
    expect(ctl.view.next).toMatchObject({ turn: 1, meta: { title: "ゲーム B" } });

    await advance(INTERLUDE_MS);
    expect(ctl.view.run.phase).toBe("running");
    expect(visible().map((f) => f.iframe)).toEqual([2]);
    // 旧 N は destroy して外す
    expect(sent.get(1)?.at(-1)).toEqual({ type: "destroy" });
    expect(ctl.view.frames.some((f) => f.iframe === 1)).toBe(false);
  });

  it("2 周目は速度 1.125 で init する（run#A.8）。iframe はずっと 3 枚以下", async () => {
    const { ctl, sent, start, advance, TURN_MS, maxFrames } = setup();
    await start();
    await advance(3 * TURN_MS);
    expect(ctl.view.run.outcomes.length).toBeGreaterThanOrEqual(3);
    const inits = [...sent.entries()]
      .filter(([iframe]) => iframe > 0)
      .flatMap(([, ms]) => ms.filter((m) => m.type === "init"));
    expect(inits.slice(0, 5).map((m) => m.speed)).toEqual([1, 1, 1, 1.125, 1.125]);
    expect(maxFrames()).toBeLessThanOrEqual(3);
  });

  it("R-run.A7-1 3 回目のミスでランが終わり、結果がすべて記録に入ってから finish を呼ぶ。成績表は finish の値", async () => {
    const { ctl, server, start, advance, TURN_MS, visible } = setup({
      plan: planOf([10, 10, 10]),
      score: () => 3,
    });
    await start();
    await advance(2 * TURN_MS + 1000 + 50);
    expect(ctl.view.run).toMatchObject({ lives: 0, phase: "flash" });
    expect(ctl.view.flash).toMatchObject({ miss: true, score: 3, isNew: false });
    expect(server.finishes).toBe(0);

    await advance(FLASH_MS);
    expect(ctl.view.run).toMatchObject({ ended: "lives", phase: "finished" });
    expect(server.puts.map((p) => p.turn)).toEqual([0, 1, 2]);
    expect(server.finishes).toBe(1);
    expect(ctl.view.report).toEqual({ kind: "ready", report: server.report });
    expect(ctl.view.unsettled).toBe(0);
    expect(ctl.view.frames).toEqual([]);
    expect(visible()).toEqual([]);
    expect(ctl.view.titles[POSTS[0]]).toEqual({ title: "ゲーム A", verb: "タップ！" });
  });
});

describe("skip（run#A.6、se#A.3、protocol#A.2）", () => {
  it("幕間の終わりに INITED でない手番は待たずに読み込みの skip。次の手番を繰り上げて幕間からやり直す", async () => {
    const { ctl, server, start, advance, visible } = setup({
      unloadable: (postId) => postId === POSTS[1],
    });
    await start();
    await advance(1000 + FLASH_MS + INTERLUDE_MS + 50);
    // 手番 1（B）は読み込みの skip。まだ幕間で、次は手番 2（C）
    expect(ctl.view.run).toMatchObject({ phase: "interlude", loadSkips: 1 });
    expect(ctl.view.next).toMatchObject({ turn: 2, meta: { title: "ゲーム C" } });
    expect(server.puts.map((p) => p.body.via)).toEqual(["guest", "noload"]);

    await advance(INTERLUDE_MS);
    expect(ctl.view.run.phase).toBe("running");
    expect(visible().map((f) => f.postId)).toEqual([POSTS[2]]);
  });

  it("ゲームの例外は {via: error} で送り、残機は減らない", async () => {
    const { ctl, server, start, advance } = setup({
      plan: planOf([10, 10, 10]),
      game: (guest, postId) => {
        if (postId !== POSTS[0]) return;
        guest.GF.onTick(() => {
          throw new Error("boom");
        });
      },
    });
    await start();
    await advance(100);
    expect(ctl.view.run).toMatchObject({ phase: "flash", lives: 3, outcomes: ["skip"] });
    expect(ctl.view.flash).toMatchObject({ via: "error", score: null, miss: false });
    expect(server.puts).toEqual([{ turn: 0, body: { via: "error" } }]);
  });

  it("表示中の iframe の 2 回目の load（iframe 自身の遷移）は即座に破棄し、その手番を error で終える（se#A.3）", async () => {
    const { ctl, server, sent, start, advance } = setup();
    await start();
    ctl.frameLoaded(1);
    expect(sent.get(1)?.at(-1)).toEqual({ type: "destroy" });
    expect(ctl.view.frames.some((f) => f.iframe === 1)).toBe(false);
    expect(ctl.view.run).toMatchObject({ phase: "flash", outcomes: ["skip"] });
    await advance(0);
    expect(server.puts).toEqual([{ turn: 0, body: { via: "error" } }]);
    // その後も進む
    await advance(FLASH_MS + INTERLUDE_MS);
    expect(ctl.view.run.phase).toBe("running");
  });

  it("表示中の Guest のスキーマ違反は破棄して error で終える（protocol#A.2）", async () => {
    const { ctl, server, start, advance } = setup();
    await start();
    ctl.receive(1, { type: "end", session_id: "s-1", score: 1, frames: 1, extra: true });
    expect(ctl.view.frames.some((f) => f.iframe === 1)).toBe(false);
    expect(ctl.view.run).toMatchObject({ phase: "flash", outcomes: ["skip"] });
    await advance(0);
    expect(server.puts).toEqual([{ turn: 0, body: { via: "error" } }]);
  });

  it("INITED の後に死んだ先読みの iframe は、start できないので error で終える（止まらない）", async () => {
    const { ctl, server, start, advance } = setup();
    await start();
    // 先読み中の手番 1（iframe 2）が遷移した
    ctl.frameLoaded(2);
    expect(ctl.view.frames.some((f) => f.iframe === 2)).toBe(false);
    await advance(1000 + FLASH_MS + INTERLUDE_MS + 50);
    expect(ctl.view.run.outcomes).toEqual(["ok", "skip"]);
    expect(server.puts.map((p) => p.body.via)).toEqual(["guest", "error"]);
    await advance(FLASH_MS + INTERLUDE_MS);
    expect(ctl.view.run.phase).toBe("running");
  });

  it("画面から外れた iframe や知らない iframe からのメッセージは捨てる", async () => {
    const { ctl, start, changes } = setup();
    await start();
    const before = changes();
    ctl.receive(99, { type: "ready" });
    ctl.frameLoaded(99);
    expect(changes()).toBe(before);
    expect(ctl.view.run.phase).toBe("running");
  });
});

describe("結果の送信と finish（run#A.7）", () => {
  it("R-run.A7-2 応答が無い間は送り直し、進行は止まらない。通じたら古い手番から順に入る", async () => {
    const { ctl, server, start, advance, TURN_MS } = setup();
    server.offline = true;
    await start();
    await advance(2 * TURN_MS);
    expect(ctl.view.run.outcomes.length).toBe(2);
    expect(ctl.view.unsettled).toBe(2);
    // 送っているのは手番 0 だけ（1 秒、2 秒…と間隔を空けて）
    expect(new Set(server.puts.map((p) => p.turn))).toEqual(new Set([0]));
    expect(server.puts.length).toBeGreaterThanOrEqual(2);

    server.offline = false;
    await advance(8000 + TURN_MS, 50);
    expect(ctl.view.unsettled).toBeLessThanOrEqual(1);
    expect(server.settled).toBeGreaterThanOrEqual(2);
    const firstOk = server.puts.findIndex((p) => p.turn === 1);
    expect(server.puts.slice(firstOk).map((p) => p.turn)).toEqual(
      [...server.puts.slice(firstOk).map((p) => p.turn)].sort((a, b) => a - b),
    );
  });

  it("ランが終わっても記録に入らなければ 10 秒待って finish。取れなければ failed になり、retryFinish で呼び直せる", async () => {
    const { ctl, server, start, advance, TURN_MS } = setup({
      plan: planOf([10, 10, 10]),
      score: () => 0,
    });
    await start();
    server.offline = true;
    await advance(2 * TURN_MS + 1000 + FLASH_MS + 50);
    expect(ctl.view.run).toMatchObject({ ended: "lives", phase: "closing" });
    expect(server.finishes).toBe(0);
    expect(ctl.view.report).toEqual({ kind: "none" });

    await advance(FINISH_WAIT_MS, 50);
    expect(ctl.view.run.phase).toBe("finished");
    expect(server.finishes).toBe(1);
    expect(ctl.view.report).toEqual({ kind: "failed" });
    expect(ctl.view.unsettled).toBe(3);

    server.offline = false;
    ctl.retryFinish();
    expect(ctl.view.report).toEqual({ kind: "loading" });
    await advance(0);
    expect(server.finishes).toBe(2);
    expect(ctl.view.report).toEqual({ kind: "ready", report: server.report });
    // 成績表が出ているときの retryFinish は何もしない
    ctl.retryFinish();
    expect(server.finishes).toBe(2);
  });
});

describe("中断と再開（run#A.9）", () => {
  it("非表示で pause、表示に戻ると「続きから」の幕間 1 秒の後に resume", async () => {
    const { ctl, sent, start, advance } = setup();
    await start();
    await advance(300);
    ctl.setHidden(true);
    expect(sent.get(1)?.at(-1)).toEqual({ type: "pause" });
    await advance(5000, 100);
    // 止まっている間は終わらない
    expect(ctl.view.run.outcomes).toEqual([]);

    ctl.setHidden(false);
    expect(ctl.view.run.phase).toBe("resuming");
    expect(ctl.view.current).toMatchObject({ title: "ゲーム A" });
    await advance(INTERLUDE_MS);
    expect(sent.get(1)?.at(-1)).toEqual({ type: "resume" });
    await advance(1000);
    expect(ctl.view.run.outcomes).toEqual(["ok"]);
  });

  it("非表示のまま 10 分で中断。表示中の手番は送らず、iframe を外して finish を呼ぶ", async () => {
    const { ctl, server, start, advance, TURN_MS } = setup();
    await start();
    await advance(TURN_MS + 300);
    ctl.setHidden(true);
    await advance(HIDDEN_ABORT_MS - 1000, 1000);
    expect(ctl.view.run.ended).toBeNull();
    await advance(2000, 1000);
    expect(ctl.view.run).toMatchObject({ ended: "abandoned", phase: "finished" });
    expect(server.puts.map((p) => p.turn)).toEqual([0]);
    expect(server.finishes).toBe(1);
    expect(ctl.view.frames).toEqual([]);
  });

  it("10 分より前に表示に戻れば中断しない", async () => {
    const { ctl, start, advance } = setup();
    await start();
    ctl.setHidden(true);
    await advance(HIDDEN_ABORT_MS - 1000, 1000);
    ctl.setHidden(false);
    await advance(5000, 100);
    expect(ctl.view.run.ended).toBeNull();
  });

  it("abort で中断する", async () => {
    const { ctl, server, start, advance } = setup();
    await start();
    ctl.abort();
    await advance(0);
    expect(ctl.view.run).toMatchObject({ ended: "abandoned", phase: "finished" });
    expect(server.finishes).toBe(1);
  });
});

describe("dispose", () => {
  it("タイマーを止め、iframe をすべて破棄し、以後は何もしない", async () => {
    const { ctl, sent, timers, start, advance, server, changes } = setup();
    await start();
    ctl.dispose();
    expect(timers).toEqual([]);
    expect(sent.get(1)?.at(-1)).toEqual({ type: "destroy" });
    expect(sent.get(2)?.at(-1)).toEqual({ type: "destroy" });
    const before = changes();
    ctl.begin();
    ctl.abort();
    ctl.setHidden(true);
    ctl.receive(1, { type: "ready" });
    await advance(5000, 100);
    expect(changes()).toBe(before);
    expect(server.finishes).toBe(0);
    expect(timers).toEqual([]);
  });
});
