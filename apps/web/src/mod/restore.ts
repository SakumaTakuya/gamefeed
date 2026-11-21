// 運営の復帰（moderation.md A.7 の restore）。理由の検査、送信、応答の読み方、結果の文面。
// 誰が呼べるかは API が決める（se#A.8 の MODERATOR_IDS）。このページは Cookie のセッションで呼ぶだけ。

/** 理由は必須（mo#A.7）。前後の空白を落として空なら null（サーバの検査と同じ） */
export function restoreReason(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

export type RestoreReply =
  /** 解けた。`status` は復帰後の投稿状態、`served` は配信（KV）に反映できたか */
  | { kind: "restored"; status: string; dismissed: number; served: boolean }
  | { kind: "signed_out" }
  /** ログインしているが運営ではない */
  | { kind: "forbidden" }
  | { kind: "not_found" }
  /** 下書きか削除済み */
  | { kind: "invalid_state" }
  /** 届かなかった・受け付けられなかった。もう一度押せる */
  | { kind: "failed"; detail: string };

const BY_ERROR: Record<string, { status: number; reply: RestoreReply }> = {
  unauthorized: { status: 401, reply: { kind: "signed_out" } },
  forbidden: { status: 403, reply: { kind: "forbidden" } },
  not_found: { status: 404, reply: { kind: "not_found" } },
  invalid_state: { status: 409, reply: { kind: "invalid_state" } },
};

/** 形を確かめてから使う。API の答えと読めないものは `failed` */
export function readRestoreReply(status: number, body: unknown): RestoreReply {
  const b = (typeof body === "object" && body !== null ? body : {}) as {
    status?: unknown;
    dismissed?: unknown;
    served?: unknown;
    error?: unknown;
    missing?: unknown;
  };
  if (
    status === 200 &&
    typeof b.status === "string" &&
    typeof b.dismissed === "number" &&
    typeof b.served === "boolean"
  ) {
    return { kind: "restored", status: b.status, dismissed: b.dismissed, served: b.served };
  }
  const error = typeof b.error === "string" ? b.error : null;
  const known = error ? BY_ERROR[error] : undefined;
  if (known && known.status === status) return known.reply;
  const missing =
    Array.isArray(b.missing) && b.missing.length > 0 ? `（${b.missing.join(", ")}）` : "";
  return { kind: "failed", detail: `${status}${error ? ` ${error}` : ""}${missing}` };
}

export async function sendRestore(postId: string, reason: string): Promise<RestoreReply> {
  try {
    const res = await fetch(`/api/moderation/posts/${encodeURIComponent(postId)}/restore`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    return readRestoreReply(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "failed", detail: "通信できませんでした" };
  }
}

/** 投稿状態の表示名（mo#A.1）。知らない値はそのまま出す */
const STATUS_LABEL: Record<string, string> = {
  public: "公開",
  limited: "限定公開",
  restricted: "制限中",
  unpublished: "非公開",
};

export function restoreText(reply: RestoreReply): string {
  switch (reply.kind) {
    case "signed_out":
      return "ログインが必要です。";
    case "forbidden":
      return "このアカウントでは使えません。";
    case "not_found":
      return "この ID の投稿はありません。";
    case "invalid_state":
      return "この投稿は下書きか削除済みなので、解く対象ではありません。";
    case "failed":
      return `解けませんでした（${reply.detail}）。もう一度押してください。`;
    case "restored": {
      const label = STATUS_LABEL[reply.status];
      const state = label ? `${label}（${reply.status}）` : reply.status;
      const head =
        reply.status === "restricted"
          ? "個別の制限は解きましたが、ツリー制限が残っているので、まだ見えません。"
          : reply.status === "unpublished"
            ? "制限を解きました。作者が非公開にしているので、作者が再公開するまで見えません。"
            : "制限を解きました。";
      const served = reply.served
        ? ""
        : "配信にはまだ反映されていません。もう一度「制限を解く」を押してください。";
      return `${head}いまの状態: ${state}。退けた通報: ${reply.dismissed} 件。${served}`;
    }
  }
}
