// 紙の重なりと、めくり（host-design#A.7）。Host の層を 1 枚の紙として持ち、紙が替わるときに前の紙をめくる。
// 進行（`controller.ts`）は知らない。受け取るのは「今どの紙か」と、その中身だけ。
// 形は `drill.ts` の `flipFrame`。ここは、それを毎フレーム要素に書く。
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import {
  FLIP_MS,
  type FlipFrame,
  flipFrame,
  type Paper,
  REDUCED_SWAP_MS,
  turnsPage,
} from "./drill.ts";

interface Leaving {
  paper: Paper;
  node: ReactNode;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** めくりの 1 コマを書く先 */
export interface FlipParts {
  /** めくられる紙（ゲームの画面と Host の層） */
  paper: readonly HTMLElement[];
  back: HTMLElement | null;
  backShade: HTMLElement | null;
  shadow: HTMLElement | null;
}

/** めくりの 1 コマを要素に書く */
export function paintFlip(parts: FlipParts, f: FlipFrame): void {
  for (const el of parts.paper) el.style.clipPath = f.clip;
  if (parts.back) {
    parts.back.style.display = f.back ? "block" : "none";
    if (f.back) {
      parts.back.style.clipPath = f.back.clip;
      parts.back.style.transform = f.back.transform;
    }
  }
  if (parts.backShade) parts.backShade.style.transform = f.crease;
  if (parts.shadow) {
    parts.shadow.style.transform = f.crease;
    parts.shadow.style.opacity = String(f.shade);
  }
}

/** めくりの間だけ書き、終わったら消すスタイル */
const TOUCHED = ["clipPath", "zIndex", "pointerEvents", "opacity"] as const;

export function Pages(props: {
  /** 今出ている紙。`game` なら Host の層は無い */
  paper: Paper;
  /**
   * 今見えているゲームの画面（iframe）。めくられる紙の一部として、Host の層と同じ形に切り抜く。
   * 要素は動かさない（別の親に移すと読み込み直しになる。hd#A.7）
   */
  frames: () => HTMLElement[];
  children: ReactNode;
}) {
  const { paper, children } = props;
  const [shown, setShown] = useState<Paper>(paper);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  /** 直前に描いた紙の中身。紙が替わった描画で、めくられる紙として残す */
  const last = useRef<ReactNode>(children);
  const leaf = useRef<HTMLDivElement | null>(null);
  const back = useRef<HTMLDivElement | null>(null);
  const backShade = useRef<HTMLElement | null>(null);
  const shadow = useRef<HTMLDivElement | null>(null);
  const framesOf = useRef(props.frames);
  framesOf.current = props.frames;

  // 紙が替わった。描く前に決める（前の紙の要素を外さずに残すため）
  if (shown !== paper) {
    setShown(paper);
    setLeaving(turnsPage(shown, paper) ? { paper: shown, node: last.current } : null);
  }
  useLayoutEffect(() => {
    last.current = children;
  });

  useLayoutEffect(() => {
    if (!leaving) return;
    const sheet = leaf.current;
    const box = sheet?.parentElement;
    if (!sheet || !box) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    const reduced = reducedMotion();
    const ms = reduced ? REDUCED_SWAP_MS : FLIP_MS;
    // めくられる紙: 前のゲームの画面と、その上の Host の層
    const paperEls = [...framesOf.current(), sheet];
    for (const el of paperEls) {
      el.style.pointerEvents = "none";
      if (el !== sheet) el.style.zIndex = "2";
    }

    const draw = (t: number) => {
      if (reduced) {
        // 動きを減らす設定: めくらず、重ねて入れ替える
        for (const el of paperEls) el.style.opacity = String(1 - t);
        return;
      }
      paintFlip(
        {
          paper: paperEls,
          back: back.current,
          backShade: backShade.current,
          shadow: shadow.current,
        },
        flipFrame(t, w, h),
      );
    };

    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - t0) / ms));
      draw(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    draw(0);
    raf = requestAnimationFrame(tick);
    // 終わりはタイマーで決める（隠れたタブでは描画のコールバックが来ない）
    const done = window.setTimeout(() => setLeaving((l) => (l === leaving ? null : l)), ms);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(done);
      for (const el of paperEls) for (const name of TOUCHED) el.style[name] = "";
    };
  }, [leaving]);

  return (
    <>
      {leaving && (
        <div key={leaving.paper} ref={leaf} className="dr-sheet dr-leaf" aria-hidden="true" inert>
          {leaving.node}
        </div>
      )}
      {paper !== "game" && (
        <div key={paper} className="dr-sheet">
          {children}
        </div>
      )}
      {leaving && <div key="shadow" ref={shadow} className="dr-flip-shadow" aria-hidden="true" />}
      {leaving && (
        <div key="back" ref={back} className="dr-flip-back" aria-hidden="true">
          <i ref={backShade} />
        </div>
      )}
    </>
  );
}
