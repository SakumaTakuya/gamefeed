// サンプルゲーム（fixtures/games/samples/、#217）がゲームの型（gc#A.1）を守っていること。
// ゲームのスクリプトを Guest ランタイムに載せ、ブラウザなしで最後まで動かす。canvas は何もしない代役。
// 手触り（開始の瞬間から操作できるか、1.5 倍で解けるか）は実機でしか分からない（README.md）。
import { readdirSync, readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { type GameMeta, staticCheck } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import { createGuest } from "../src/guest.ts";
import type { GuestToHost, InputLogEntry, InputLogKind } from "../src/messages.ts";

const DIR = new URL("../../../fixtures/games/samples/", import.meta.url);
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();
const read = (name: string) => readFileSync(new URL(name, DIR), "utf8");

const A = 16 / 9;
type Input = [InputLogKind, ...number[]];
/** ゲームの中の式を読む（トップレベルの変数が見える）。値は JSON で受け取る */
type Peek = <T>(expr: string) => T;
/** フレーム f の入力を決める。見えるのはフレーム f − 1 までの結果 */
type Bot = (peek: Peek, frame: number) => Input[];

interface Played {
  score: number;
  frames: number;
  inputs: InputLogEntry[];
  errors: string[];
}

function metaOf(html: string): GameMeta {
  const r = staticCheck(html);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.meta;
}

function play(
  html: string,
  opts: { seed: number; bot?: Bot; draw?: boolean; replay?: InputLogEntry[] },
): Played {
  const meta = metaOf(html);
  const sent: GuestToHost[] = [];
  const clock = { t: 1000 };
  const guest = createGuest({ post: (m) => sent.push(m), now: () => clock.t });
  // 呼ばれても何もしない 2D コンテキスト
  const ctx2d = new Proxy<Record<string | symbol, unknown>>(
    {},
    { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => Reflect.set(t, k, v) },
  );
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 360,
    clientHeight: 640,
    getContext: () => ctx2d,
  };
  const GF =
    opts.draw === false
      ? new Proxy(guest.GF, {
          get: (t, k) => (k === "onDraw" ? () => undefined : Reflect.get(t, k)),
          set: (t, k, v) => Reflect.set(t, k, v),
        })
      : guest.GF;
  const context = createContext({ GF, document: { getElementById: () => canvas } });
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    new Script(m[1] as string).runInContext(context);
  }
  const peek: Peek = (expr) =>
    JSON.parse(new Script(`JSON.stringify(${expr})`).runInContext(context) as string);

  guest.ready(meta);
  guest.receive({
    type: "init",
    session_id: "s",
    seed: opts.seed,
    mode: opts.replay ? "replay" : "play",
    time_limit: meta.duration,
    speed: 1,
    ...(opts.replay ? { inputs: opts.replay } : {}),
  });
  guest.receive({ type: "start" });
  for (let i = 0; i < meta.duration + 10 && guest.state === "RUNNING"; i++) {
    if (opts.bot)
      for (const [kind, ...data] of opts.bot(peek, guest.GF.frame)) guest.input(kind, data);
    clock.t = 1000 + ((i + 1) * 1000) / 60;
    guest.frame();
  }
  const end = sent.find((m) => m.type === "end");
  return {
    score: end?.type === "end" ? end.score : Number.NaN,
    frames: end?.type === "end" ? end.frames : Number.NaN,
    inputs: sent.flatMap((m) => (m.type === "log" ? m.inputs : [])),
    errors: sent.flatMap((m) => (m.type === "error" ? [m.message] : [])),
  };
}

const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 256) / 256;

/** 「上手い人」の代わり。ゲームの状態を見て、人にもできる入力（1 フレームに 1 つまで）を返す */
const BOTS: Record<string, Bot> = {
  "stop-gauge.html": (peek) => {
    const s = peek<{ r: number; p: number; g: number; v: number }>(
      "({ r: round, p: pos, g: goal, v: speed })",
    );
    return s.r < 3 && Math.abs(s.p - s.g) <= s.v * 0.6 ? [["tap", 0.5, 0.5]] : [];
  },
  "mole.html": (peek) => {
    const up = peek<number[]>("up");
    const holes = peek<[number, number][]>("HOLES");
    const i = up.findIndex((n) => n > 1);
    const hole = holes[i];
    return hole ? [["tap", hole[0], hole[1] / A]] : [];
  },
  "balloon.html": (peek, frame) => {
    if (frame === 0) return [["hold", 0.5, 0.5, 1]];
    const s = peek<{ size: number; limit: number; holding: boolean }>("({ size, limit, holding })");
    return s.holding && s.size + 0.0008 + s.size * 0.012 > s.limit ? [["hold", 0.5, 0.5, 0]] : [];
  },
  "hover.html": (peek) => {
    const s = peek<{ y: number; vy: number; bandY: number; holding: boolean }>(
      "({ y, vy, bandY, holding })",
    );
    const want = s.y + s.vy * 12 > s.bandY;
    return want === s.holding ? [] : [["hold", 0.5, 0.5, want ? 1 : 0]];
  },
  "slash.html": (peek) => {
    const f = peek<{ x: number; y: number }[]>("fruits").find((o) => o.y > 0.1 && o.y < A - 0.1);
    return f ? [["swipe", f.x - 0.12, f.y / A, f.x + 0.12, f.y / A]] : [];
  },
  "arrows.html": (peek) => {
    const s = peek<{ dir: number; wait: number; freeze: number }>("({ dir, wait, freeze })");
    if (s.wait > 0 || s.freeze > 0) return [];
    const dx = [1, 0, -1, 0][s.dir] as number;
    const dy = [0, 1, 0, -1][s.dir] as number;
    return [["swipe", 0.5, 0.5, 0.5 + dx * 0.3, 0.5 + dy * 0.2]];
  },
  "catch.html": (peek) => {
    const stars = peek<{ x: number; y: number }[]>("stars").filter((s) => s.y < 1.5);
    const low = stars.sort((a, b) => b.y - a.y)[0];
    return low ? [["drag", q(low.x), 0.85, 1]] : [];
  },
  "dodge.html": (peek) => {
    const s = peek<{ px: number; shots: { x: number; y: number; vy: number }[] }>(
      "({ px, shots })",
    );
    // 左へ・その場・右へ、をそれぞれ 45 フレーム先まで進めてみて、いちばん長く当たらないものを選ぶ
    const survive = (dir: number): number => {
      let x = s.px;
      for (let t = 1; t <= 45; t++) {
        x = Math.min(0.96, Math.max(0.04, x + dir * 0.03));
        for (const b of s.shots) {
          if ((b.x - x) ** 2 + (b.y + b.vy * t - 1.45) ** 2 < 0.09 ** 2) return t;
        }
      }
      return 46;
    };
    const toCenter = s.px < 0.5 ? 1 : -1;
    const dir = [0, toCenter, -toCenter].sort((a, b) => survive(b) - survive(a))[0] as number;
    return [["drag", q(s.px + dir * 0.2), 0.85, 1]];
  },
  "paint.html": (_peek, frame) => {
    const row = Math.floor(frame / 9);
    if (row >= 12) return [];
    const k = (frame % 9) / 8;
    const x = 0.03 + (row % 2 === 0 ? k : 1 - k) * 0.94;
    return [["drag", q(x), q((0.2 + (row + 0.5) / 8) / A), 1]];
  },
  "hurdle.html": (peek, frame) => {
    const s = peek<{ h: number; obs: number[] }>("({ h, obs })");
    const speed = 0.018 + frame * 0.000012;
    const ahead = s.obs.filter((x) => x > 0.25).sort((a, b) => a - b)[0];
    return s.h === 0 && ahead !== undefined && ahead - 0.03 - 0.29 <= speed * 7
      ? [["tap", 0.5, 0.5]]
      : [];
  },
  "quickdraw.html": (peek) => {
    const s = peek<{ lit: boolean; done: boolean }>("({ lit, done })");
    return s.lit && !s.done ? [["tap", 0.5, 0.5]] : [];
  },
  "throw.html": (peek) => {
    const s = peek<{ ball: unknown; target: { x: number; y: number } }>("({ ball, target })");
    return s.ball ? [] : [["swipe", 0.5, 1.5 / A, s.target.x, s.target.y / A]];
  },
};

const botOf = (name: string): Bot => {
  const bot = BOTS[name];
  if (!bot) throw new Error(`${name} の入力（BOTS）がテストに無い`);
  return bot;
};

describe("サンプルゲーム（#217、R-gc.A1-1）", () => {
  it("12 本あり、題名と動詞が重ならず、tap / hold / swipe / drag がどれも 2 本以上ある", () => {
    const metas = FILES.map((f) => metaOf(read(f)));
    expect(FILES.length).toBe(12);
    expect(new Set(metas.map((m) => m.title)).size).toBe(metas.length);
    expect(new Set(metas.map((m) => m.verb)).size).toBe(metas.length);
    for (const kind of ["tap", "hold", "swipe", "drag"]) {
      expect(metas.filter((m) => m.input === kind).length, kind).toBeGreaterThanOrEqual(2);
    }
    // 長さも散っている（3 秒から 10 秒まで）
    const durations = metas.map((m) => m.duration);
    expect(Math.min(...durations)).toBe(180);
    expect(Math.max(...durations)).toBe(600);
  });

  it("README.md の表に、すべてのファイルが 1 行ずつある", () => {
    const readme = read("README.md");
    const listed = [...readme.matchAll(/^\| `([a-z-]+\.html)` \|/gm)].map((m) => m[1] as string);
    expect(listed.sort()).toEqual(FILES);
  });

  describe.each(FILES)("%s", (name) => {
    const html = read(name);

    it("静的検査を拒否も警告もなしで通る（gc#A.11）", () => {
      const r = staticCheck(html);
      expect(r.ok ? r.warnings : r.errors).toEqual([]);
    });

    it("入力なしでも時間切れまでに終わり、点数は目標に届かない（gc#A.1 の 1・4）", () => {
      const meta = metaOf(html);
      for (let seed = 0; seed < 30; seed++) {
        const r = play(html, { seed });
        expect(r.errors, `seed ${seed}`).toEqual([]);
        expect(r.frames, `seed ${seed}`).toBeGreaterThanOrEqual(1);
        expect(r.frames, `seed ${seed}`).toBeLessThanOrEqual(meta.duration);
        expect(Number.isInteger(r.score) && r.score >= 0, `seed ${seed}: ${r.score}`).toBe(true);
        expect(r.score, `seed ${seed}`).toBeLessThan(meta.target);
      }
    });

    it("上手い入力なら、どの seed でも目標に届く（gc#A.1 の 5、A.10）", () => {
      const meta = metaOf(html);
      for (let seed = 0; seed < 30; seed++) {
        const r = play(html, { seed, bot: botOf(name) });
        expect(r.errors, `seed ${seed}`).toEqual([]);
        expect(r.score, `seed ${seed}`).toBeGreaterThanOrEqual(meta.target);
        expect(r.frames, `seed ${seed}`).toBeLessThanOrEqual(meta.duration);
      }
    });

    it("同じ seed と同じ入力で同じ点数になる。replay でも同じ（gc#A.1 の 7、A.9）", () => {
      for (const seed of [7, 8, 9]) {
        const a = play(html, { seed, bot: botOf(name) });
        const b = play(html, { seed, bot: botOf(name) });
        expect([b.score, b.frames, b.inputs]).toEqual([a.score, a.frames, a.inputs]);
        const r = play(html, { seed, replay: a.inputs });
        expect([r.score, r.frames], `seed ${seed}`).toEqual([a.score, a.frames]);
      }
    });

    it("描画しなくても同じ点数になる（onDraw が状態を変えない。gc#A.4）", () => {
      for (const seed of [7, 8, 9]) {
        const a = play(html, { seed, bot: botOf(name) });
        const b = play(html, { seed, bot: botOf(name), draw: false });
        expect([b.score, b.frames]).toEqual([a.score, a.frames]);
      }
    });
  });
});
