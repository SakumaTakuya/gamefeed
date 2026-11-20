// `createSinglePlayer` をブラウザにつなぐ（iframe への postMessage、window のタイマー、message の購読）。
import type { Speed } from "@gamefeed/domain";
import { type RefObject, useEffect, useReducer, useRef } from "react";
import { createSinglePlayer, type SinglePlayer } from "./player.ts";

/** @param speed 既定は等速。途中で変えても作り直さない */
export function useSinglePlayer(speed?: Speed): {
  player: SinglePlayer;
  frameRef: RefObject<HTMLIFrameElement | null>;
} {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<SinglePlayer | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // 配線は iframe 1 つにつき 1 つ。再描画や StrictMode の再実行で作り直さない
  if (!playerRef.current) {
    playerRef.current = createSinglePlayer({
      env: {
        // Guest は不透明オリジン（sandbox）なので、宛先のオリジンは指定できない（pr#A.1）
        post: (m) => frameRef.current?.contentWindow?.postMessage(m, "*"),
        now: () => performance.now(),
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
        newSessionId: () => crypto.randomUUID(),
        newSeed: () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
      },
      ...(speed !== undefined ? { speed } : {}),
      onChange: rerender,
    });
  }
  const player = playerRef.current;

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // 不透明オリジンなので origin は見ず、送り元が自分の iframe であることを確かめる（pr#A.1）
      const frame = frameRef.current?.contentWindow;
      if (!frame || ev.source !== frame) return;
      player.receive(ev.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [player]);

  return { player, frameRef };
}
