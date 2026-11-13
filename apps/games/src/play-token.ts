// 試遊トークンの検証（se#A.5）。
// 形: base64url(post_id + "." + exp) + "." + base64url(HMAC-SHA256(secret, post_id + "." + exp))。exp は Unix 秒。
// 発行は API（GET /api/posts/{id}/play-token）。Worker は検証だけを行う。

const B64URL = /^[A-Za-z0-9_-]+$/;
const EXP = /^[0-9]{1,12}$/;

function fromBase64Url(s: string): Uint8Array | null {
  if (!B64URL.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * トークンが `postId` 向けで、署名が正しく、`exp` が `nowSec` より未来なら true。
 * 署名の比較は `crypto.subtle.verify`（定数時間）に任せる。
 */
export async function verifyPlayToken(
  secret: string,
  token: string,
  postId: string,
  nowSec: number,
): Promise<boolean> {
  if (!secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const payload = fromBase64Url(parts[0] ?? "");
  const signature = fromBase64Url(parts[1] ?? "");
  if (!payload || !signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify("HMAC", key, signature, payload))) return false;

  // 署名が正しいものだけ中身を読む
  const text = new TextDecoder().decode(payload);
  const dot = text.lastIndexOf(".");
  if (dot < 0) return false;
  const exp = text.slice(dot + 1);
  if (text.slice(0, dot) !== postId || !EXP.test(exp)) return false;
  return Number(exp) > nowSec;
}
