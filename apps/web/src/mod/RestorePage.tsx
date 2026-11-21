// 運営の最小ページ: 投稿の制限を解く（moderation.md A.7 の restore）。運営画面の本体（キュー・ほかの操作）は W6。
// このページは誰でも開けるが、操作は API が MODERATOR_IDS のユーザーにだけ通す（se#A.8）。
import { useState } from "react";
import { signInWithGoogle } from "../sign-in.ts";
import { type RestoreReply, restoreReason, restoreText, sendRestore } from "./restore.ts";

export function RestorePage({ postId }: { postId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState<RestoreReply | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const reason = restoreReason(text);

  const submit = async () => {
    if (!reason || sending) return;
    setSending(true);
    setReply(await sendRestore(postId, reason));
    setSending(false);
  };

  return (
    <main style={styles.page}>
      <h1 style={styles.h1}>投稿の制限を解く</h1>
      <p style={styles.id}>{postId}</p>
      <p>
        個別の制限を外し、この投稿への未解決の通報をすべて退けます（通報した人の信頼スコアが 2
        ずつ下がります）。
      </p>
      <label style={styles.label}>
        理由（必須。記録に残ります）
        <textarea
          style={styles.input}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button
        type="button"
        style={{ ...styles.button, opacity: reason && !sending ? 1 : 0.5 }}
        disabled={!reason || sending}
        onClick={submit}
      >
        {sending ? "送っています…" : "制限を解く"}
      </button>

      {reply && (
        <p style={reply.kind === "restored" && reply.served ? styles.done : styles.error}>
          {restoreText(reply)}
        </p>
      )}
      {reply?.kind === "restored" && (
        <p>
          <a href={`/g/${postId}`}>ゲームページを開く</a>
        </p>
      )}
      {reply?.kind === "signed_out" && (
        <>
          <button
            type="button"
            style={styles.button}
            onClick={() => signInWithGoogle().catch((e) => setSignInError(String(e?.message ?? e)))}
          >
            Google でログイン
          </button>
          {signInError && <p style={styles.error}>{signInError}</p>}
        </>
      )}
    </main>
  );
}

const styles = {
  page: {
    maxWidth: "28rem",
    margin: "3rem auto",
    padding: "0 1rem",
    lineHeight: 1.7,
    fontFamily: "system-ui, sans-serif",
  },
  h1: { fontSize: "1.25rem" },
  id: { fontFamily: "ui-monospace, monospace", fontSize: "0.85rem", wordBreak: "break-all" },
  label: { display: "block", margin: "1rem 0" },
  // 16px 未満の入力欄は iOS Safari がフォーカスで画面を拡大する
  input: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    marginTop: "0.3rem",
    padding: "0.6rem",
    font: "inherit",
    fontSize: "16px",
    borderRadius: "0.6rem",
    border: "1px solid #888",
  },
  button: {
    font: "inherit",
    padding: "0.7rem 1.4rem",
    borderRadius: "0.6rem",
    border: "1px solid #888",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
  },
  done: { color: "#2e7d32" },
  error: { color: "#c62828" },
} as const;
