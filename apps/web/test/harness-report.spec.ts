// ハーネスのページが出す結果（sc#A.10。R-sc.A10-1）。
import { type GameMeta, isSpeed, type SessionState } from "@gamefeed/domain";
import { describe, expect, it } from "vitest";
import { harnessReport, harnessSpeed } from "../src/harness/report.ts";
import { routeOf } from "../src/route.ts";

const meta: GameMeta = { title: "t", verb: "タップ！", input: "tap", duration: 180, target: 10 };
const ended = (result: Extract<SessionState, { kind: "ENDED" }>["result"]): SessionState => ({
  kind: "ENDED",
  meta,
  sessionId: "s",
  mode: "play",
  result,
});
const of = (
  state: SessionState,
  halted: "navigated" | "no_ready" | null = null,
  problem: string | null = null,
) => harnessReport({ state, halted, problem });

describe("R-sc.A10-1 harnessReport（状態から結果へ）", () => {
  it("ready を待つ間は loading、準備ができたら ready", () => {
    expect(of({ kind: "LOADING" })).toEqual({ phase: "loading" });
    expect(of({ kind: "READY", meta })).toEqual({ phase: "ready" });
  });

  it("end が届けば ended。点数とフレームを出す", () => {
    expect(of(ended({ via: "guest", score: 7, frames: 180, scoreable: true }))).toEqual({
      phase: "done",
      outcome: "ended",
      score: 7,
      frames: 180,
    });
  });

  it("監視タイマー満了は timeout、例外は error（メッセージを付ける）", () => {
    expect(of(ended({ via: "timeout", scoreable: true }))).toEqual({
      phase: "done",
      outcome: "timeout",
      detail: null,
    });
    expect(of(ended({ via: "error", scoreable: true }), null, "boom")).toEqual({
      phase: "done",
      outcome: "error",
      detail: "boom",
    });
  });

  it("ready が来ない・iframe の遷移・プロトコル違反は、それぞれの名前で終わる", () => {
    expect(of({ kind: "DESTROYED" }, "no_ready")).toMatchObject({ outcome: "no_ready" });
    expect(of({ kind: "DESTROYED" }, "navigated")).toMatchObject({ outcome: "navigated" });
    expect(of({ kind: "DESTROYED" }, null, "unknown type")).toEqual({
      phase: "done",
      outcome: "violation",
      detail: "unknown type",
    });
  });

  it("速度は ?speed= で受け、知らない値は等速", () => {
    expect(harnessSpeed("?speed=1.5", isSpeed)).toBe(1.5);
    expect(harnessSpeed("", isSpeed)).toBe(1);
    expect(harnessSpeed("?speed=9", isSpeed)).toBe(1);
    expect(harnessSpeed("?speed=x", isSpeed)).toBe(1);
  });

  it("/harness/<post_id> はハーネスのページ", () => {
    expect(routeOf("/harness/01M834X8RJ306PZ096Y56PRQV4")).toEqual({
      page: "harness",
      postId: "01M834X8RJ306PZ096Y56PRQV4",
    });
    expect(routeOf("/harness/x")).toEqual({ page: "home" });
  });
});
