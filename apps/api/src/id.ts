/**
 * ULID（dm#A.1: `users.id` / `posts.id` / `sessions.id` / `runs.id`）。
 * 先頭 10 文字が時刻（ミリ秒、48 bit）、後ろ 16 文字が乱数（80 bit）。Crockford の Base32。
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(nowMs: number, random: Uint8Array = randomBytes(10)): string {
  let time = "";
  let t = Math.floor(nowMs);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80 bit を 5 bit ずつ 16 文字に
  let bits = 0n;
  for (const b of random.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}
