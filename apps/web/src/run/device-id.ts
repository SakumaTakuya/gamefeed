// 遊ぶ側の主体の `device_id`（dm#A.1、se#A.2）。クライアントが作る 128 bit の乱数で、認証ではない。
// 主体が要る API にヘッダ `X-Device-Id` で渡す（#161 の 1）。

export const DEVICE_ID_HEADER = "X-Device-Id";
export const DEVICE_ID_KEY = "gf:device_id";

/** サーバが受ける形（`apps/api/src/actors.ts` と同じ） */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

export interface DeviceIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 保存してある `device_id` を返す。無い・形が違うときは作って保存する。
 * ストレージが使えない（プライベートブラウズなどで例外）ときは、保存せずに作った値を返す。
 * その場合は呼ぶたびに別の値になるので、呼び出し側は 1 回だけ呼んで持っておく。
 * @param random 渡した配列を乱数で埋めて返す（`crypto.getRandomValues`）
 */
export function deviceId(
  storage: DeviceIdStorage,
  random: (bytes: Uint8Array) => Uint8Array,
): string {
  try {
    const saved = storage.getItem(DEVICE_ID_KEY);
    if (saved !== null && DEVICE_ID_RE.test(saved)) return saved;
  } catch {
    // 読めなければ作る
  }
  const id = base64url(random(new Uint8Array(16)));
  try {
    storage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // 保存できなくても、このページの間は使える
  }
  return id;
}
