// ゲームページに出すものの組み立て（run#A.14、mo#A.3、product#9）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GameMeta, SessionState } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import type { PostLookup } from "../src/game/api.ts";
import { gameView, UNAVAILABLE_TEXT } from "../src/game/view.ts";

const meta: GameMeta = {
  title: "まるタップ",
  verb: "タップ！",
  input: "tap",
  duration: 180,
  target: 10,
};
const session = { meta, sessionId: "s-1", mode: "play" } as const;
const of = (
  state: SessionState,
  halted: "navigated" | "no_ready" | null = null,
  lookup: PostLookup | null = null,
  likedHere = false,
  deviation: number | null = null,
) =>
  gameView({
    state,
    meta: "meta" in state ? state.meta : null,
    halted,
    lookup,
    likedHere,
    deviation,
  });
const found: Extract<PostLookup, { kind: "found" }> = {
  kind: "found",
  post: {
    postId: "01M782MV00TMYMTHTGG5C6KS3T",
    title: "まるタップ",
    handle: "taku-sakuma",
    liked: false,
    stats: null,
  },
};
const BINS = [
  { from: 0, to: 9, count: 30 },
  { from: 10, to: 19, count: 60 },
  { from: 20, to: 29, count: 0 },
  { from: 30, to: 400, count: 30 },
];
/** 校正済みの投稿（プレイ数・いいね数・分布の区間が付く） */
const calibrated: PostLookup = {
  kind: "found",
  post: { ...found.post, stats: { plays: 120, likes: 7, histogram: BINS } },
};

describe("gameView", () => {
  it("R-run.A14-1 読み込み中 → 動詞と題名でスタートを待つ → 遊んでいる間は何も出さない", () => {
    expect(of({ kind: "LOADING" })).toEqual({ kind: "loading" });
    expect(of({ kind: "READY", meta })).toEqual({ kind: "loading" });
    expect(of({ kind: "INITED", ...session, timeLimit: 180, speed: 1 })).toEqual({
      kind: "start",
      verb: "タップ！",
      title: "まるタップ",
      author: null,
      stats: null,
    });
    const active = { ...session, timeLimit: 180, speed: 1, startedAt: 0, log: null } as never;
    expect(of({ kind: "RUNNING", deadlineAt: 1, ...(active as object) } as SessionState)).toEqual({
      kind: "playing",
    });
  });

  it("R-run.A14-1 結果は点数。時間切れとエラーは点数を出さない", () => {
    const ended = (result: Extract<SessionState, { kind: "ENDED" }>["result"]) =>
      of({ kind: "ENDED", ...session, result });
    expect(ended({ via: "guest", score: 12, frames: 180, scoreable: true })).toEqual({
      kind: "result",
      main: "12 点",
      sub: null,
      like: null,
      canReport: false,
      deviation: null,
      stats: null,
      histogram: null,
    });
    expect(ended({ via: "guest", score: 0, frames: 0, scoreable: true })).toMatchObject({
      main: "0 点",
    });
    expect(ended({ via: "timeout", scoreable: true })).toEqual({
      kind: "result",
      main: "—",
      sub: "時間切れ",
      like: null,
      canReport: false,
      deviation: null,
      stats: null,
      histogram: null,
    });
    expect(ended({ via: "error", scoreable: true })).toEqual({
      kind: "result",
      main: "—",
      sub: "エラー",
      like: null,
      canReport: false,
      deviation: null,
      stats: null,
      histogram: null,
    });
  });

  it("R-run.A14-2 ready が届かなかった投稿は「開けません」。理由（下書き・制限・非公開・削除・存在しない）を区別しない（mo#A.3）", () => {
    expect(of({ kind: "DESTROYED" }, "no_ready")).toEqual({ kind: "unavailable" });
    expect(UNAVAILABLE_TEXT).toBe("このゲームは開けません");
  });

  it("R-run.A14-3 投稿が読めたら、スタートの幕に作者の handle を出す。読めていない間・読めなかったときは出さずに遊べる", () => {
    const inited: SessionState = { kind: "INITED", ...session, timeLimit: 180, speed: 1 };
    expect(of(inited, null, found)).toEqual({
      kind: "start",
      verb: "タップ！",
      title: "まるタップ",
      author: "taku-sakuma",
      stats: null,
    });
    expect(of(inited, null, { kind: "unknown" })).toMatchObject({ kind: "start", author: null });
    expect(of({ kind: "LOADING" }, null, found)).toEqual({ kind: "loading" });
  });

  it("R-run.A14-2 API が not_found を返したら、ゲームの状態によらずすぐ「開けません」（ready を 5 秒待たない）", () => {
    const gone: PostLookup = { kind: "not_found" };
    expect(of({ kind: "LOADING" }, null, gone)).toEqual({ kind: "unavailable" });
    expect(of({ kind: "INITED", ...session, timeLimit: 180, speed: 1 }, null, gone)).toEqual({
      kind: "unavailable",
    });
    expect(of({ kind: "DESTROYED" }, "navigated", gone)).toEqual({ kind: "unavailable" });
  });

  it("R-run.A14-2 API が落ちていても、配信されない投稿は今までどおり ready 待ちの時間切れで「開けません」", () => {
    expect(of({ kind: "DESTROYED" }, "no_ready", { kind: "unknown" })).toEqual({
      kind: "unavailable",
    });
  });

  it("R-run.A14-4 結果の幕のいいね: 投稿が読めていれば出す。サーバでいいね済みか、このページで押したら「済み」", () => {
    const ended: SessionState = {
      kind: "ENDED",
      ...session,
      result: { via: "guest", score: 3, frames: 180, scoreable: true },
    };
    const likeOf = (lookup: PostLookup | null, likedHere = false) => {
      const v = of(ended, null, lookup, likedHere);
      return v.kind === "result" ? v.like : undefined;
    };
    expect(likeOf(found)).toEqual({ liked: false });
    expect(likeOf(found, true)).toEqual({ liked: true });
    expect(likeOf({ kind: "found", post: { ...found.post, liked: true } })).toEqual({
      liked: true,
    });
    // 投稿が読めていない（まだ・API が落ちている）ときは、送れないので出さない
    expect(likeOf(null, true)).toBeNull();
    expect(likeOf({ kind: "unknown" })).toBeNull();
    // 時間切れ・エラーで終わっても、遊んだゲームにはいいねできる
    expect(
      (
        of(
          { kind: "ENDED", ...session, result: { via: "timeout", scoreable: true } },
          null,
          found,
        ) as {
          like: unknown;
        }
      ).like,
    ).toEqual({ liked: false });
  });

  it("R-run.A14-5 結果の幕の通報: 投稿が読めているときだけ出す", () => {
    const ended: SessionState = {
      kind: "ENDED",
      ...session,
      result: { via: "error", scoreable: true },
    };
    const can = (lookup: PostLookup | null) => {
      const v = of(ended, null, lookup);
      return v.kind === "result" ? v.canReport : undefined;
    };
    expect(can(found)).toBe(true);
    expect(can(null)).toBe(false);
    expect(can({ kind: "unknown" })).toBe(false);
  });

  it("R-run.A14-6 校正済みの投稿は、スタートの幕と結果の幕にプレイ数といいね数を出す。校正済みでない・読めていないときは出さない", () => {
    const inited: SessionState = { kind: "INITED", ...session, timeLimit: 180, speed: 1 };
    const ended: SessionState = {
      kind: "ENDED",
      ...session,
      result: { via: "timeout", scoreable: true },
    };
    for (const state of [inited, ended]) {
      expect(of(state, null, calibrated)).toMatchObject({ stats: { plays: 120, likes: 7 } });
      expect(of(state, null, found)).toMatchObject({ stats: null });
      expect(of(state, null, { kind: "unknown" })).toMatchObject({ stats: null });
      expect(of(state, null, null)).toMatchObject({ stats: null });
    }
  });

  it("R-run.A14-6 このページでいいねを押したら、いいね数も 1 増やす。読んだ時点でいいね済みなら数えてあるので増やさない", () => {
    const ended: SessionState = {
      kind: "ENDED",
      ...session,
      result: { via: "guest", score: 3, frames: 180, scoreable: true },
    };
    expect(of(ended, null, calibrated, true)).toMatchObject({ stats: { plays: 120, likes: 8 } });
    const already: PostLookup = {
      kind: "found",
      post: { ...found.post, liked: true, stats: { plays: 120, likes: 7, histogram: [] } },
    };
    expect(of(ended, null, already, true)).toMatchObject({ stats: { plays: 120, likes: 7 } });
  });

  it("R-run.A14-6 結果の幕の「今の偏差値」: 点数のある結果で、値が届いているときだけ。小数 1 桁", () => {
    const guest: SessionState = {
      kind: "ENDED",
      ...session,
      result: { via: "guest", score: 3, frames: 180, scoreable: true },
    };
    const devOf = (state: SessionState, value: number | null) => {
      const v = of(state, null, calibrated, false, value);
      return v.kind === "result" ? v.deviation : undefined;
    };
    expect(devOf(guest, 62.3)).toBe("62.3");
    expect(devOf(guest, 50)).toBe("50.0");
    expect(devOf(guest, 80)).toBe("80.0");
    // まだ届いていない・校正済みでない（サーバが null を返す）
    expect(devOf(guest, null)).toBeNull();
    // 時間切れ・エラーには点数が無い。前の結果の値が残っていても出さない
    for (const via of ["timeout", "error"] as const) {
      expect(
        devOf({ kind: "ENDED", ...session, result: { via, scoreable: true } }, 62.3),
      ).toBeNull();
    }
  });

  it("R-run.A14-7 結果の幕のヒストグラム: 棒の高さは最大の件数に対する比。点数のある結果は、その点数の入る棒に印", () => {
    const histOf = (
      result: Extract<SessionState, { kind: "ENDED" }>["result"],
      lookup: PostLookup = calibrated,
    ) => {
      const v = of({ kind: "ENDED", ...session, result }, null, lookup);
      return v.kind === "result" ? v.histogram : undefined;
    };
    const guest = (score: number) => histOf({ via: "guest", score, frames: 180, scoreable: true });
    expect(guest(12)).toEqual({
      from: 0,
      to: 400,
      bars: [
        { ratio: 0.5, mine: false },
        { ratio: 1, mine: true },
        { ratio: 0, mine: false },
        { ratio: 0.5, mine: false },
      ],
    });
    // 分布の外の点数は端の棒
    expect(guest(100000)?.bars.map((b) => b.mine)).toEqual([false, false, false, true]);
    // 時間切れ・エラーは図だけ（印なし）
    for (const via of ["timeout", "error"] as const) {
      expect(histOf({ via, scoreable: true })?.bars.some((b) => b.mine)).toBe(false);
    }
    // 校正済みでない・読めていない・区間が無い（古い応答）ときは出さない
    const result = { via: "guest", score: 12, frames: 180, scoreable: true } as const;
    expect(histOf(result, found)).toBeNull();
    expect(histOf(result, { kind: "unknown" })).toBeNull();
    expect(
      histOf(result, {
        kind: "found",
        post: { ...found.post, stats: { plays: 120, likes: 7, histogram: [] } },
      }),
    ).toBeNull();
  });

  it("R-run.A14-7 スタートの幕にはヒストグラムを出さない（遊ぶ前に点数の相場を見せない）", () => {
    const v = of({ kind: "INITED", ...session, timeLimit: 180, speed: 1 }, null, calibrated);
    expect(v).not.toHaveProperty("histogram");
    expect(v).toMatchObject({ stats: { plays: 120, likes: 7 } });
    expect((v as { stats: object }).stats).not.toHaveProperty("histogram");
  });

  it("遊べていたゲームを Host が止めたときは「止めました」（遷移、プロトコル違反）", () => {
    expect(of({ kind: "DESTROYED" }, "navigated")).toEqual({ kind: "stopped" });
    expect(of({ kind: "DESTROYED" })).toEqual({ kind: "stopped" });
  });

  it("R-run.A14-2 ゲームページは診断コピー・デバッグ表示・速度の変更を持たない（run#A.12、product#9）", () => {
    for (const file of ["game/GamePage.tsx", "game/view.ts", "game/api.ts", "game/report.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
      expect(src, file).not.toMatch(/diagnose|診断|clipboard|problem|inputs/);
      expect(src, file).not.toMatch(/play-token|token/i);
    }
  });
});
