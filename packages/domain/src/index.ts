// 純粋なドメインロジック。I/O を持たない。Node とブラウザの両方で動く。

/** テストや Host が注入する時計。製品コードでは performance.now() 相当を包む。 */
export interface Clock {
  /** ミリ秒。単調増加。 */
  now(): number;
}

export const DOMAIN_VERSION = "0.0.0";

export * from "./forbidden-identifiers.ts";
export * from "./session.ts";
export * from "./static-check.ts";
