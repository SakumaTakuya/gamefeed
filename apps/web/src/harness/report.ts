// ハーネスのページが外へ出す結果（scoring.md A.10）。DOM に触らない。
// 公開直後のジョブ（apps/api の post-publish）が、ページの `data-harness` からこの形を読む。
import type { SessionState } from "@gamefeed/domain";
import type { Halt } from "../single/player.ts";

export type HarnessReport =
  /** `ready` を待っている */
  | { phase: "loading" }
  /** `init` を送った。`start` はページがすぐ送る */
  | { phase: "ready" }
  /** フレームが進んでいる */
  | { phase: "running" }
  /** `end` が届いた（`GF.end()` を呼ばず制限時間で終わるのも含む） */
  | { phase: "done"; outcome: "ended"; score: number; frames: number }
  /**
   * - `timeout`: 監視タイマー満了（固まった）
   * - `error`: ゲームのコールバックで例外
   * - `no_ready`: 読み込めたのに `ready` が来ない
   * - `navigated`: iframe が自分で遷移した
   * - `violation`: プロトコル違反で破棄した
   */
  | {
      phase: "done";
      outcome: "timeout" | "error" | "no_ready" | "navigated" | "violation";
      detail: string | null;
    };

export function harnessReport(p: {
  state: SessionState;
  halted: Halt | null;
  problem: string | null;
}): HarnessReport {
  if (p.halted) return { phase: "done", outcome: p.halted, detail: p.problem };
  switch (p.state.kind) {
    case "LOADING":
      return { phase: "loading" };
    case "READY":
    case "INITED":
      return { phase: "ready" };
    case "RUNNING":
    case "PAUSED":
      return { phase: "running" };
    case "DESTROYED":
      return { phase: "done", outcome: "violation", detail: p.problem };
    case "ENDED": {
      const r = p.state.result;
      if (r.via === "guest") {
        return { phase: "done", outcome: "ended", score: r.score, frames: r.frames };
      }
      return { phase: "done", outcome: r.via, detail: p.problem };
    }
  }
}

/** `?speed=` の値。SPEEDS に無ければ等速 */
export function harnessSpeed(search: string, isSpeed: (x: unknown) => boolean): number {
  const raw = new URLSearchParams(search).get("speed");
  const n = raw === null ? 1 : Number(raw);
  return isSpeed(n) ? n : 1;
}
