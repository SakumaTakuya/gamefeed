// users.handle の生成（mcp.md A.5）。auth_user.name を slug にする。
// 一意性は DB の UNIQUE が担保する。ここは候補を作るだけで、I/O を持たない。

/** handle の長さ（文字数）。mc#A.5 */
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

const trimHyphens = (s: string): string => s.replace(/^-+|-+$/g, "");

/**
 * 名前から handle の元を作る。
 * NFKC 正規化 → 小文字 → `a-z0-9` 以外を `-` に → 連続する `-` を 1 つに → 前後の `-` を除く → 20 文字に切る。
 * 3 文字未満・空（記号だけ、非ラテン文字だけ）なら `user-<id の末尾 6 文字（小文字）>`。
 */
export function handleBase(name: string, userId: string): string {
  const slug = trimHyphens(
    name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
  );
  const cut = trimHyphens(slug.slice(0, HANDLE_MAX));
  if (cut.length < HANDLE_MIN) return `user-${userId.slice(-6).toLowerCase()}`;
  return cut;
}

/**
 * 衝突したときの n 番目の候補（n は 1 始まり）。1 番目は元のまま、2 番目以降は `-2`, `-3`, … を付ける。
 * 20 文字を超えるなら元を縮める。
 */
export function handleCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${trimHyphens(base.slice(0, HANDLE_MAX - suffix.length))}${suffix}`;
}
