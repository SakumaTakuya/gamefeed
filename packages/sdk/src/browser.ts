/**
 * Guest ランタイム（guest.ts）をブラウザにつなぐ（gc#A.3〜A.5、protocol#A.1）。
 * 配信時に <head> の先頭へ注入され、ゲームのスクリプトより先に動く。
 */
import type { GameMeta, InputKind } from "@gamefeed/domain";
import { createGuest } from "./guest.ts";
import { createPointerInput, normalize } from "./pointer.ts";

/** SDK が置く viewport（gc#A.2）。ゲームが書いたものは置き換える。 */
export const VIEWPORT =
  "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

function metaContent(doc: Document, name: string): string {
  return doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
}

/** `<title>` と `gf:*` のメタ宣言（gc#A.3）。範囲の検査は Host のスキーマが行う。 */
export function readMeta(doc: Document): GameMeta {
  return {
    title: doc.title.trim(),
    verb: metaContent(doc, "gf:verb"),
    input: metaContent(doc, "gf:input") as InputKind,
    duration: Number(metaContent(doc, "gf:duration")),
    target: Number(metaContent(doc, "gf:target")),
  };
}

export function installGuest(win: Window): void {
  const doc = win.document;
  // ゲームに差し替えられる前の実体をつかんでおく
  const perf = win.performance;
  const now = perf.now.bind(perf);
  const raf = win.requestAnimationFrame.bind(win);
  const host = win.parent;
  // 直接開かれたとき（親がいない）は誰にも送らない
  const embedded = host !== win;
  const send = host.postMessage.bind(host);

  const guest = createGuest({
    // Guest は不透明オリジンで、Host のオリジンを知らない。送るのは記録と結果だけ（protocol#A.4）
    post: (message) => {
      if (embedded) send(message, "*");
    },
    now,
  });
  Object.defineProperty(win, "GF", { value: guest.GF, writable: false, configurable: false });

  win.addEventListener("message", (ev) => {
    // 不透明オリジンなので origin は見ず、送り元が親であることを確かめる（protocol#A.1）
    if (!embedded || ev.source !== host) return;
    guest.receive(ev.data);
  });

  function onReady(): void {
    for (const el of Array.from(doc.querySelectorAll('meta[name="viewport"]'))) el.remove();
    const viewport = doc.createElement("meta");
    viewport.setAttribute("name", "viewport");
    viewport.setAttribute("content", VIEWPORT);
    doc.head.appendChild(viewport);
    // スクロールやズームのジェスチャーに入力を取られないようにする
    doc.documentElement.style.touchAction = "none";

    const meta = readMeta(doc);
    const pointer = createPointerInput(meta.input, (kind, data) => guest.input(kind, data));
    const x = (ev: PointerEvent) => normalize(ev.clientX, win.innerWidth);
    const y = (ev: PointerEvent) => normalize(ev.clientY, win.innerHeight);
    win.addEventListener("pointerdown", (ev) => {
      // iframe の外で離しても pointerup が届くようにする（押しっぱなしで固まらないように）
      try {
        doc.documentElement.setPointerCapture(ev.pointerId);
      } catch {
        // 既に離れた指などで失敗しても、入力は続ける
      }
      pointer.down(ev.pointerId, x(ev), y(ev));
    });
    win.addEventListener("pointermove", (ev) => pointer.move(ev.pointerId, x(ev), y(ev)));
    win.addEventListener("pointerup", (ev) => pointer.up(ev.pointerId, x(ev), y(ev)));
    win.addEventListener("pointercancel", (ev) => pointer.cancel(ev.pointerId));

    guest.ready(meta);
  }

  // メタ宣言とゲームのコールバック登録は、文書を読み終えてからそろう
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", onReady);
  else onReady();

  const loop = (): void => {
    guest.frame();
    raf(loop);
  };
  raf(loop);
}
