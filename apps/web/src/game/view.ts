// ゲームページ（run#A.14）に出すものの組み立て。公開後のページなので、
// 作者向けの情報（Guest の例外の文面、入力ログ、速度）は出さない（run#A.12、product#9）。
import { type GameMeta, histogramIndex, type SessionState } from "@gamefeed/domain";
import type { Halt } from "../single/player.ts";
import type { PostLookup, PostStats } from "./api.ts";

/** 幕に出す数（校正済みの投稿だけ。product#9 の 5） */
export type Counts = Pick<PostStats, "plays" | "likes">;

/** 点数の分布の図（product#9 の 5）。`from`〜`to` は図の両端の点数 */
export interface HistogramView {
  from: number;
  to: number;
  /** `ratio` は最大の件数に対する比（0〜1）。`mine` は今の結果の点数の入る棒 */
  bars: { ratio: number; mine: boolean }[];
}

export type GameView =
  | { kind: "loading" }
  /** 「タップしてスタート」を待っている */
  | { kind: "start"; verb: string; title: string; author: string | null; stats: Counts | null }
  /** 遊んでいる間は iframe の上に何もかぶせない（se#A.3） */
  | { kind: "playing" }
  /** `like` は、投稿が読めていて、いいねを送れるときだけ（null なら出さない） */
  | {
      kind: "result";
      main: string;
      sub: string | null;
      like: { liked: boolean } | null;
      /** 通報を出すか。いいねと同じく、投稿が読めているときだけ */
      canReport: boolean;
      /** 「今の偏差値」（product#5.3）。小数 1 桁。点数のある結果で、値が届いているときだけ */
      deviation: string | null;
      /** プレイ数といいね数。校正済みの投稿だけ（product#9 の 5） */
      stats: Counts | null;
      /** 点数の分布。校正済みの投稿だけ。点数のある結果なら、その点数の入る棒に印が付く */
      histogram: HistogramView | null;
    }
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
  /** `GET /api/posts/{id}` の結果。まだ返っていなければ null */
  lookup: PostLookup | null;
  /** このページでいいねを押した（送信中と成功。失敗したら戻す） */
  likedHere: boolean;
  /** 今の結果の点数に対する `GET /api/posts/{id}/deviation` の値。まだ・校正済みでない・届かないなら null */
  deviation: number | null;
}): GameView {
  const { state, lookup } = p;
  const found = lookup?.kind === "found" ? lookup.post : null;
  // このページで押したいいねは、読んだ時点の数に入っていない
  const stats = found?.stats
    ? { plays: found.stats.plays, likes: found.stats.likes + (p.likedHere && !found.liked ? 1 : 0) }
    : null;
  // API が「無い」と言ったら、iframe の様子によらず開けない（ready を待たない）
  if (lookup?.kind === "not_found") return { kind: "unavailable" };
  const histogramOf = (score: number | null): HistogramView | null => {
    const bins = found?.stats?.histogram ?? [];
    const first = bins[0];
    const last = bins[bins.length - 1];
    if (!first || !last) return null;
    const most = Math.max(1, ...bins.map((b) => b.count));
    const mine = score === null ? null : histogramIndex(bins, score);
    return {
      from: first.from,
      to: last.to,
      bars: bins.map((b, i) => ({ ratio: b.count / most, mine: i === mine })),
    };
  };
  switch (state.kind) {
    case "LOADING":
    case "READY":
      return { kind: "loading" };
    case "INITED":
      return {
        kind: "start",
        verb: state.meta.verb,
        title: state.meta.title,
        author: found?.handle ?? null,
        stats,
      };
    case "RUNNING":
    case "PAUSED":
      return { kind: "playing" };
    case "ENDED": {
      const r = state.result;
      const like = found ? { liked: found.liked || p.likedHere } : null;
      const canReport = found !== null;
      if (r.via === "guest") {
        const deviation = p.deviation === null ? null : p.deviation.toFixed(1);
        return {
          kind: "result",
          main: `${r.score} 点`,
          sub: null,
          like,
          canReport,
          deviation,
          stats,
          histogram: histogramOf(r.score),
        };
      }
      const sub = r.via === "timeout" ? "時間切れ" : "エラー";
      return {
        kind: "result",
        main: "—",
        sub,
        like,
        canReport,
        deviation: null,
        stats,
        histogram: histogramOf(null),
      };
    }
    case "DESTROYED":
      return p.halted === "no_ready" ? { kind: "unavailable" } : { kind: "stopped" };
  }
}
