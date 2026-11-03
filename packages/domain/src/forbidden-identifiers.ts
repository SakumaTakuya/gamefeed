// 静的解析（spec#4.1「禁止API（静的）」「時間・乱数」、spec#4.4）の禁止識別子一覧。
// 字句レベルの検出なので難読化は見抜けない（意図的な割り切り。spec#4.4）。
// 項目を足したら test/static-check.spec.ts の samples にも例を足す。

export interface ForbiddenIdentifier {
  /** エラー文に出す名前。テストの samples のキーと一致させる */
  name: string;
  /** 検出パターン。コメントと文字列リテラルを除いたコードに対して適用する */
  pattern: RegExp;
  /** 何が問題か（1 文） */
  reason: string;
  /** 代わりに何を使うか（1 文） */
  fix: string;
}

/** グローバル識別子（直前が `.` や識別子文字でない） */
const g = (id: string) => new RegExp(`(?<![\\w$.])${id}(?![\\w$])`);
/** `obj.method` 形（ドット前後の空白を許容） */
const m = (obj: string, prop: string) =>
  new RegExp(`(?<![\\w$.])${obj}\\s*\\.\\s*${prop}(?![\\w$])`);

const ASSETS = "アセットは GF.assets.load('./assets/<name>') で読み込んでください。";
const NET = "ゲームは外部と通信できません。通信に関するコードを削除してください。";

export const FORBIDDEN_IDENTIFIERS: readonly ForbiddenIdentifier[] = [
  { name: "fetch", pattern: g("fetch"), reason: "fetch は使えません。", fix: ASSETS },
  {
    name: "XMLHttpRequest",
    pattern: g("XMLHttpRequest"),
    reason: "XMLHttpRequest は使えません。",
    fix: ASSETS,
  },
  { name: "WebSocket", pattern: g("WebSocket"), reason: "WebSocket は使えません。", fix: NET },
  {
    name: "EventSource",
    pattern: g("EventSource"),
    reason: "EventSource は使えません。",
    fix: NET,
  },
  {
    name: "navigator.sendBeacon",
    pattern: m("navigator", "sendBeacon"),
    reason: "navigator.sendBeacon は使えません。",
    fix: NET,
  },
  {
    name: "import(",
    pattern: /(?<![\w$.])import\s*\(/,
    reason: "動的 import は使えません。",
    fix: 'ライブラリは <script src="/lib/<name>@<version>.min.js"> で読み込んでください。',
  },
  {
    name: "eval",
    pattern: g("eval"),
    reason: "eval は使えません。",
    fix: "文字列からコードを生成せず、関数として直接書いてください。",
  },
  {
    name: "new Function",
    pattern: /(?<![\w$.])new\s+Function(?![\w$])/,
    reason: "new Function は使えません。",
    fix: "文字列からコードを生成せず、関数として直接書いてください。",
  },
  {
    name: "document.cookie",
    pattern: m("document", "cookie"),
    reason: "document.cookie は使えません。",
    fix: "ゲームはデータを保存できません。状態は変数に持ってください。",
  },
  {
    name: "localStorage",
    pattern: g("localStorage"),
    reason: "localStorage は使えません。",
    fix: "ゲームはデータを保存できません。状態は変数に持ってください。",
  },
  {
    name: "indexedDB",
    pattern: g("indexedDB"),
    reason: "indexedDB は使えません。",
    fix: "ゲームはデータを保存できません。状態は変数に持ってください。",
  },
  {
    name: "open(",
    pattern: /(?<![\w$.])(?:window\s*\.\s*)?open\s*\(/,
    reason: "window.open は使えません。",
    fix: "別ウィンドウやページ遷移は使わず、ゲーム内で完結させてください。",
  },
  {
    name: "location =",
    pattern:
      /(?<![\w$.])(?:(?:window|document)\s*\.\s*)?location\s*(?:\.\s*\w+\s*)?=(?!=)|(?<![\w$.])(?:(?:window|document)\s*\.\s*)?location\s*\.\s*(?:assign|replace|reload)\s*\(/,
    reason: "location への代入（ページ遷移）は使えません。",
    fix: "別ウィンドウやページ遷移は使わず、ゲーム内で完結させてください。",
  },
  {
    name: "Math.random",
    pattern: m("Math", "random"),
    reason: "Math.random は使えません（リプレイが再現できなくなります）。",
    fix: "GF.rng() を使ってください。",
  },
  {
    name: "Date.now",
    pattern: m("Date", "now"),
    reason: "Date.now は使えません（リプレイが再現できなくなります）。",
    fix: "時間は GF.frame（フレーム数）で測ってください。",
  },
  {
    name: "performance.now",
    pattern: m("performance", "now"),
    reason: "performance.now は使えません（リプレイが再現できなくなります）。",
    fix: "時間は GF.frame（フレーム数）で測ってください。",
  },
  {
    name: "setTimeout",
    pattern: g("setTimeout"),
    reason: "setTimeout は使えません。",
    fix: "GF.onTick の中でフレーム数を数えてください。",
  },
  {
    name: "setInterval",
    pattern: g("setInterval"),
    reason: "setInterval は使えません。",
    fix: "GF.onTick の中でフレーム数を数えてください。",
  },
  {
    name: "requestAnimationFrame",
    pattern: g("requestAnimationFrame"),
    reason: "requestAnimationFrame は使えません。",
    fix: "描画は GF.onTick の中で行ってください。",
  },
];
