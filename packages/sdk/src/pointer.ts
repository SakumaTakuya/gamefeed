/**
 * pointer イベントを、ゲームが宣言した `gf:input` の入力に直す（gc#A.4）。
 * DOM に触らない。座標は呼び出し側が 0〜1 に正規化して渡す。
 */
import type { InputKind } from "@gamefeed/domain";
import type { InputLogKind } from "./messages.ts";

/** 画面に対する 0〜1 の座標。範囲外は端に寄せる。 */
export function normalize(px: number, size: number): number {
  if (!(size > 0)) return 0;
  return Math.min(1, Math.max(0, px / size));
}

/** drag の位置は 1/256 刻み（gc#A.4）。 */
export function quantize(v: number): number {
  return Math.round(v * 256) / 256;
}

export interface PointerInput {
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  cancel(id: number): void;
}

/**
 * 1 本目の指だけを追う。2 本目以降は離れるまで無視する。
 * `stick` は別 Issue（`GF.stick` の解釈と描画が要る）なので、ここでは何も出さない。
 */
export function createPointerInput(
  kind: InputKind,
  emit: (kind: InputLogKind, data: number[]) => void,
): PointerInput {
  let active: { id: number; x0: number; y0: number; x: number; y: number } | null = null;

  function release(x: number, y: number, cancelled: boolean): void {
    const a = active;
    if (!a) return;
    active = null;
    if (kind === "hold") emit("hold", [x, y, 0]);
    else if (kind === "drag") emit("drag", [quantize(x), quantize(y), 0]);
    else if (kind === "swipe" && !cancelled) emit("swipe", [a.x0, a.y0, x, y]);
  }

  return {
    down(id, x, y) {
      if (active) return;
      active = { id, x0: x, y0: y, x, y };
      // tap は押した瞬間に出す。離すのを待つと、動く的を狙うゲームで遅れになる（gc#A.4、#117）
      if (kind === "tap") emit("tap", [x, y]);
      else if (kind === "hold") emit("hold", [x, y, 1]);
      else if (kind === "drag") {
        active.x = quantize(x);
        active.y = quantize(y);
        emit("drag", [active.x, active.y, 1]);
      }
    },
    move(id, x, y) {
      if (!active || active.id !== id) return;
      if (kind === "drag") {
        const qx = quantize(x);
        const qy = quantize(y);
        if (qx === active.x && qy === active.y) return;
        active.x = qx;
        active.y = qy;
        emit("drag", [qx, qy, 1]);
      } else {
        active.x = x;
        active.y = y;
      }
    },
    up(id, x, y) {
      if (active?.id === id) release(x, y, false);
    },
    cancel(id) {
      if (active?.id === id) release(active.x, active.y, true);
    },
  };
}
