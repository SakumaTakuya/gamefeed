// ゲームページ（run#A.14）に出すものの組み立て。公開後のページなので、
// 作者向けの情報（Guest の例外の文面、入力ログ、速度）は出さない（run#A.12、product#9）。
import type { GameMeta, SessionState } from "@gamefeed/domain";
import type { Halt } from "../single/player.ts";

export type GameView =
  | { kind: "loading" }
  /** 「タップしてスタート」を待っている */
  | { kind: "start"; verb: string; title: string }
  /** 遊んでいる間は iframe の上に何もかぶせない（se#A.3） */
  | { kind: "playing" }
  | { kind: "result"; main: string; sub: string | null }
  /** 配信されない投稿。理由は区別しない（mo#A.3、mc#A.9） */
  | { kind: "unavailable" }
  /** 遊べていたゲームを Host が止めた（iframe の遷移、プロトコル違反） */
  | { kind: "stopped" };

/** 下書き・制限中・非公開・削除済み・存在しない投稿のどれでも同じ文言（mo#A.3） */
export const UNAVAILABLE_TEXT = "このゲームは開けません";
export const STOPPED_TEXT = "ゲームを止めました";

export function gameView(p: {
  state: SessionState;
  meta: GameMeta | null;
  halted: Halt | null;
}): GameView {
  const { state } = p;
  switch (state.kind) {
    case "LOADING":
    case "READY":
      return { kind: "loading" };
    case "INITED":
      return { kind: "start", verb: state.meta.verb, title: state.meta.title };
    case "RUNNING":
    case "PAUSED":
      return { kind: "playing" };
    case "ENDED": {
      const r = state.result;
      if (r.via === "guest") return { kind: "result", main: `${r.score} 点`, sub: null };
      return { kind: "result", main: "—", sub: r.via === "timeout" ? "時間切れ" : "エラー" };
    }
    case "DESTROYED":
      return p.halted === "no_ready" ? { kind: "unavailable" } : { kind: "stopped" };
  }
}
