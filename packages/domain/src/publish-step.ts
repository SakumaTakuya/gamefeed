// publish_game が対象の投稿に対して何をするか（mc#A.7 の表）。verification/Publish.tla の Tx と対応する。
//
// 守るのは「公開後は内容を変えない」（dm#A.5 I10）。禁じるのは内容を変える要求だけで、
// 同じ内容の呼び直しは投稿がどの状態でも拒まない（removed を除く）。#97

/** `posts.base_status`。`restricted` は導出値なので、ここでは `limited` / `public` のまま渡す */
export type PublishBase = "draft" | "limited" | "public" | "unpublished" | "removed";

/** 対象の投稿の決まり方（mc#A.6 の 3） */
export type PublishTarget =
  /** `post_id` がなく、同じ内容の自分の投稿もない */
  | { by: "none" }
  /** `post_id` で指した自分の投稿。`sameContent` は `html` のハッシュがその投稿の `game_hash` と同じか */
  | { by: "post_id"; base: PublishBase; sameContent: boolean }
  /** `post_id` がなく、同じ内容で見つけた自分の投稿 */
  | { by: "content"; base: PublishBase };

export type PublishStep =
  /** 新しい下書きを作る（上限と静的検査を通す） */
  | "create"
  /** 下書きの内容を置き換える（静的検査を通す。`publish: true` なら公開する） */
  | "replace"
  /** 同じ内容の下書きに戻る。`title` / `prompt` だけ更新し、公開しない */
  | "refresh"
  /** 公開後の投稿をそのまま返す。何も変えない */
  | "keep"
  /** `invalid_state`: 公開後の投稿の内容は変えられない */
  | "immutable"
  /** `invalid_state`: 運営が消した投稿・内容 */
  | "removed";

export function publishStep(target: PublishTarget): PublishStep {
  if (target.by === "none") return "create";
  if (target.base === "removed") return "removed";
  if (target.base === "draft") return target.by === "post_id" ? "replace" : "refresh";
  // limited / public / unpublished
  if (target.by === "content" || target.sameContent) return "keep";
  return "immutable";
}

/**
 * `post_id` なしのとき、同じ `game_hash` を持つ自分の投稿から対象を選ぶ（mc#A.7 の補足）。
 * `sameContent` は `updated_at` の新しい順。`removed` が 1 つでもあれば、その内容は再投稿できない。
 */
export function sameContentTarget<P extends { base: PublishBase }>(
  sameContent: readonly P[],
): { by: "none" } | { by: "content"; base: PublishBase; post: P } {
  const removed = sameContent.find((p) => p.base === "removed");
  if (removed) return { by: "content", base: "removed", post: removed };
  const first = sameContent[0];
  return first ? { by: "content", base: first.base, post: first } : { by: "none" };
}
