// Host が Guest を埋め込む iframe（se#A.3）。属性はここでだけ決める。
// 試遊ページもラン画面もこの部品を使い、ほかの場所で <iframe> を書かない（`test/game-frame.spec.tsx`）。
import type { CSSProperties, Ref } from "react";

const shown = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  border: 0,
  display: "block",
} satisfies CSSProperties;

/** 先読み中（run#A.4）。大きさは表示中と同じにして、ゲームが正しい大きさで準備できるようにする */
const hidden = { ...shown, visibility: "hidden", pointerEvents: "none" } satisfies CSSProperties;

export function GameFrame(props: {
  /** `gameUrl` が作った URL（se#A.2） */
  src: string;
  /** false なら不可視（スロット N+1、N+2） */
  visible: boolean;
  onLoad?: () => void;
  ref?: Ref<HTMLIFrameElement>;
}) {
  return (
    <iframe
      ref={props.ref}
      title="ゲーム"
      src={props.src}
      // allow-scripts だけ。allow-same-origin を付けないことが最重要（se#A.3）
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // React は credentialless を真偽値の属性として扱う。空文字を渡すと付かない（#184）。
      // 型定義にまだ無いので、広げて渡す
      {...{ credentialless: true }}
      onLoad={props.onLoad}
      style={props.visible ? shown : hidden}
    />
  );
}
