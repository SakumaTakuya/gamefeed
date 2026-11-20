// Host の画面の枠に共通の指定（ラン画面、試遊ページ）。
import type { CSSProperties } from "react";

/**
 * 連続タップで画面が拡大しないようにする（#190）。Guest の側は SDK が `touch-action: none` を入れるが、
 * Host の層（スタート、幕間、結果、ヘッダー）と余白に落ちたタップはここで止める。
 * `manipulation` はダブルタップ拡大だけを止め、スクロール（成績表）とピンチは残す。
 */
export const HOST_STAGE = {
  touchAction: "manipulation",
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
} satisfies CSSProperties;
