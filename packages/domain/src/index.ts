// 純粋なドメインロジック。I/O を持たない。Node とブラウザの両方で動く。
// 実装は Issue 単位で TDD で追加する（#6 セッション状態機械、#8 静的解析）。

/** テストや Host が注入する時計。製品コードでは performance.now() 相当を包む。 */
export interface Clock {
  /** ミリ秒。単調増加。 */
  now(): number;
}

export const DOMAIN_VERSION = "0.0.0";
