// Google でログインを始める（se#A.8）。終わったら今のページに戻る。試遊ページと運営のページが使う。
export async function signInWithGoogle(): Promise<void> {
  const res = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: location.pathname }),
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string };
  if (!res.ok || !data.url) throw new Error(`ログインを始められませんでした（${res.status}）`);
  location.href = data.url;
}
