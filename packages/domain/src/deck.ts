// エンドレスの山札の組み方（run#A.2、A.10、sc#A.8）。サーバの POST /runs が使う。I/O を持たない。
// 候補（出せるゲームと、その人が直近に引いた日時）は呼び出し側が DB から集めて渡す。

import { ENDLESS_DECK_SIZE } from "./run-record.ts";

/** 直近この日数のうちにその人が引いたゲームを山札の抽選から除く（run#A.2。暫定） */
export const DECK_RECENT_DAYS = 7;

export interface DeckCandidate {
  postId: string;
  /** `post_eligibility`（dm#A.4）。normal は校正済みの公開ゲーム、new は未校正（新作枠） */
  kind: "normal" | "new";
  /** その人が直近（DECK_RECENT_DAYS 日以内）に引いた日時。引いていなければ null。大小だけを比べる */
  drawnAt: number | null;
}

export interface Deck {
  /** 山札の `post_id`。1〜ENDLESS_DECK_SIZE 本、重複なし */
  deck: string[];
  /** 山札の中で新作扱い（`is_new`）にする位置。昇順 */
  newIndexes: number[];
}

/** Fisher–Yates。random は [0, 1) を返す */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/**
 * エンドレスの山札を引く（run#A.2）。出せるゲームが 0 本なら null（`POST /runs` は 409 `no_games`）。
 *
 * - 直近に引いたものを除いて抽選する。それで ENDLESS_DECK_SIZE 本に足りないときだけ、
 *   引いた日が古いものから除外を外す
 * - 未校正が 1 本でもあれば新作枠 1 本、残りの正規枠は校正済み。校正済みが足りない分は未校正で埋め、
 *   埋めた位置も新作扱いにする（#123）。未校正がなければ校正済みだけ
 * - それでも足りなければ山札を短くする。同じゲームを重ねない
 * - 並びと新作扱いの位置は random で決める（run#A.10）
 */
export function buildEndlessDeck(
  candidates: readonly DeckCandidate[],
  random: () => number,
): Deck | null {
  const unique = [...new Map(candidates.map((c) => [c.postId, c])).values()];
  const notDrawn = unique.filter((c) => c.drawnAt === null);
  const drawn = unique
    .filter((c) => c.drawnAt !== null)
    .sort(
      (a, b) => (a.drawnAt as number) - (b.drawnAt as number) || (a.postId < b.postId ? -1 : 1),
    );
  const pool = [...notDrawn, ...drawn.slice(0, Math.max(0, ENDLESS_DECK_SIZE - notDrawn.length))];
  if (pool.length === 0) return null;

  const normals = shuffled(
    pool.filter((c) => c.kind === "normal"),
    random,
  );
  const news = shuffled(
    pool.filter((c) => c.kind === "new"),
    random,
  );
  const newSlot = Math.min(1, news.length);
  const regular = Math.min(ENDLESS_DECK_SIZE - newSlot, normals.length);
  const filled = Math.min(ENDLESS_DECK_SIZE - newSlot - regular, news.length - newSlot);
  const picked = shuffled(
    [...normals.slice(0, regular), ...news.slice(0, newSlot + filled)],
    random,
  );
  return {
    deck: picked.map((c) => c.postId),
    newIndexes: picked.flatMap((c, i) => (c.kind === "new" ? [i] : [])),
  };
}
