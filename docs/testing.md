# テスト方針

目的は「仕様書の要件が守られていることを、できるだけ本物に近い形で、継続的に確かめる」こと。
カバレッジ率は目標にしない。代わりに `docs/requirements.md` の対応表で、どの要件がどの層のテストで守られているかを見る。

## 1. 層の定義

| 層 | 対象 | 実行環境 | 本物を使う範囲 | 道具 |
| --- | --- | --- | --- | --- |
| unit | `packages/domain` の純粋ロジック（状態機械、静的解析、ラン生成、メッセージスキーマ） | Node | すべて本物。mock なし | Vitest |
| integration | `apps/api` のルート＋DB、`apps/games` の Worker＋R2、`packages/sdk` の Host↔Guest ブリッジ | Node / Workers / 実ブラウザ | DB は本物の Postgres（CI は service container、ローカルは Supabase CLI または Docker）。R2 は Miniflare の本物相当。認証はテスト用ユーザーで実際にログイン | Vitest、Miniflare、Playwright |
| contract | Host と Guest の postMessage プロトコル（`docs/protocol.md`）。片側を仕様どおりの最小実装に置き換えて、もう片側を検証 | 実ブラウザ | iframe・postMessage・sandbox 属性は本物 | Playwright |
| e2e | ユーザー視点の一連の流れ（お題を開く→ランを完走→結果画面、投稿→試遊→公開） | 実ブラウザ（Chromium、WebKit） | 全部本物。サンプルゲーム（`fixtures/games/`）を使う | Playwright |
| manual | 実機でしか分からないこと（iOS Safari の音声、幕間のテンポ、タッチ感、Muse からの接続） | 実機 | — | 手順書と結果を PR 本文に残す |
| formal | 状態機械の性質（`verification/`） | TLC | モデル | TLA+。TS の union 型と遷移テーブルがモデルと一致することを unit で検証 |

「本物を使う」の原則: 境界の外側（他社サービス、時計、乱数、ネットワーク断）だけを差し替える。差し替えるときはインターフェースを `packages/domain` に置き、テスト用実装も製品コードと同じ型を満たす。
- 時計: `Clock` インターフェース。テストでは手動で進める実装。
- 乱数: seed を渡す（`game-contract.md` の決定論性と同じ仕組み）。
- Muse / Claude などの MCP クライアント: 公式 SDK のクライアントで実際に接続する（integration）。Muse 本体は manual。
- R2 / Postgres: mock しない。本物か本物相当を使う。

## 2. 要件からテストへ

仕様書の各要件に ID を付け、設計時点でテスト層を決める。対応表は `docs/requirements.md`。

- ID の形式: `R-<章>.<節>-<連番>`（例: `R-6.3-2` 「動詞は 1〜8 文字」）。
- 各要件に「層」「検証方法（1 行）」「テストの場所」「状態（未着手 / 赤 / 緑 / manual 済）」を持つ。
- Issue を切るときに、関係する要件 ID を列挙する。ID のない要件を見つけたら表に追加してから Issue を書く。
- テスト名に ID を含める: `it("R-6.3-2 動詞が 9 文字なら静的解析が拒否する", ...)`。
- 「目視のみ」の要件も表に載せる。載せないと忘れる。

どの層にするかの目安:
- 入出力が値で決まる → unit
- DB・ストレージ・HTTP・iframe を跨ぐ → integration
- 2 つの実装が同じプロトコルを守る必要がある → contract
- ユーザーの一連の操作で初めて意味がある → e2e
- 端末や人の感覚に依存する → manual
- 「同時に 2 つ存在しない」「必ず終わる」のような全経路の性質 → formal

## 3. TDD の進め方

1. Issue の要件 ID ごとに、**失敗するテストを先に書く**。最初のテストは「最も典型的なケース」。
2. 通す最小の実装を書く。
3. リファクタ。
4. 次のケースへ。順番は固定:
   - 典型（正常系の代表 1 つ）
   - 境界（範囲の端、0、最大、空）
   - 異常（不正入力、順序違反、重複）
   - 並行・時間（遅延して届くメッセージ、タイマー満了と `end` の競合、pause 中の到着）
5. 既存のテストを壊したら、仕様を見て「テストが古い」か「実装が間違い」かを決めてから直す。テストを黙って緩めない。

テストを書かないもの:
- 見た目（色、余白、フォント）。manual の対象。
- 外部ライブラリ自体の挙動。
- 1 行の glue コード（ただし integration で間接的に通ること）。

## 4. 層ごとの書き方

### unit（`packages/domain`）
- 入力→出力の表で書ける形にする。`describe` を要件 ID の節ごとに分ける。
- 状態機械は「状態 × イベント → 次の状態 or 拒否」の遷移表をデータとして持ち、テストは表を網羅する。TLA+ の遷移名と同じ名前を使う。
- 乱数・時計は引数で渡す。

### integration
- Postgres: マイグレーション適用済みの空 DB から始め、テストごとにトランザクションで巻き戻す。
- `apps/api`: Hono の `app.request()` で HTTP を通す。認証はテスト用のセッションを本物の Better Auth で作る。
- `apps/games`: Miniflare で Worker を起動し、R2 に実際に置いた HTML がどの CSP ヘッダ付きで返るかを見る。
- Host↔Guest: Playwright で実 iframe を作り、`sandbox="allow-scripts"` のまま postMessage を流す。

### contract
- `packages/sdk` に「仕様どおりの最小 Guest」と「最小 Host」を置く（fixtures）。
- Host の実装は最小 Guest に対して、Guest の SDK は最小 Host に対して検証する。
- スキーマ違反（余計なフィールド、型違い、順序違反）が必ずセッション破棄になることを確認する。

### e2e
- `fixtures/games/` に動詞・入力の型ごとのサンプルを置き、CI で使う。
- 1 シナリオ 1 ファイル。ランの完走、投稿→試遊→公開、通報→非公開 の 3 本から始める。
- WebKit でも回す（iOS Safari の代理。完全ではないので manual と併用）。

### manual
- `docs/manual-tests/` に手順書を置く（端末、OS バージョン、手順、期待結果）。
- 実施結果は PR 本文に日付・端末・結果を書く。

### formal
- `spec/tla/` に TLA+ モデルを置き、`tlc` を CI の手動ジョブで回せるようにする。
- unit テストで「TS の遷移表 ⊆ TLA+ の遷移」を機械的に確認する（モデルから遷移一覧を JSON に落として比較）。

## 5. CI
- PR ごと: lint / typecheck / unit / integration（Postgres service）/ contract / e2e（Chromium）。
- 夜間または手動: e2e（WebKit）、TLC。
- 赤のままマージしない。flaky なテストは `test.skip` ではなく Issue を切って原因を直す。
