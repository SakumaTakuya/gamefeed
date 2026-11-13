// 「診断をコピー」の文面（product#9 の 3。暫定）。作者はこれを AI に貼って「直して」と言う。
import type { GameMeta, SessionResult, Speed } from "@gamefeed/domain";

export interface Diagnosis {
  postId: string;
  /** `ready` で届いたメタ宣言。届いていなければ null */
  meta: GameMeta | null;
  speed: Speed;
  /** 直近のセッションの結果。終わっていなければ null */
  result: SessionResult | null;
  /** 記録された入力の数 */
  inputs: number;
  /** Guest の例外、プロトコル違反、ページ移動などの理由 */
  problem: string | null;
}

const VIA: Record<SessionResult["via"], string> = {
  guest: "正常（end が届いた）",
  timeout: "時間切れ（end が届かなかった）",
  error: "例外で停止",
};

export function diagnose(d: Diagnosis): string {
  const lines = ["GameFeed 試遊の診断", `post_id: ${d.postId}`];
  const notes: string[] = [];
  const { meta, result } = d;

  lines.push(
    meta
      ? `ゲーム: ${meta.title}（動詞: ${meta.verb} / 入力: ${meta.input} / 長さ: ${meta.duration} フレーム / target: ${meta.target}）`
      : "ゲーム: （ready が届いていません。SDK が動く前に例外が出ている可能性があります）",
  );
  lines.push(`速度: ${d.speed} 倍`);
  lines.push(`終わり方: ${result ? VIA[result.via] : "中断"}`);

  if (result && meta) {
    lines.push(
      `点: ${result.score}（target ${meta.target} ${result.score >= meta.target ? "以上" : "未満"}）`,
    );
    if (result.frames !== undefined) lines.push(`フレーム: ${result.frames} / ${meta.duration}`);
    lines.push(`入力: ${d.inputs} 回`);

    if (result.via === "timeout") {
      notes.push(
        "end が届きませんでした。onTick の中の無限ループや重い処理で固まっている可能性があります。",
      );
    }
    if (result.via === "guest") {
      if (result.score === 0) {
        notes.push("点が 0 のままでした。GF.score への加算が呼ばれているか確かめてください。");
      }
      if (result.frames !== undefined && result.frames < meta.duration) {
        notes.push(
          `${meta.duration} フレームに届かず ${result.frames} フレームで終わりました。GF.end() を呼んでいないなら、onTick か onDraw が重くて処理が追いついていません。`,
        );
      }
    }
    if (result.via !== "error" && d.inputs === 0) {
      notes.push(
        "入力が 1 回も記録されていません。入力は GF.onInput で受けてください（addEventListener の入力は記録されません）。",
      );
    }
    if (result.flagged) notes.push("入力ログの順序が乱れました（SDK の不具合の可能性）。");
  }
  if (d.problem) lines.push(`例外: ${d.problem}`);

  if (notes.length === 0) lines.push("気づき: なし");
  else lines.push("気づき:", ...notes.map((n) => `- ${n}`));
  return lines.join("\n");
}
