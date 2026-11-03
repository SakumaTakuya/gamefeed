# 要件→テスト対応表

仕様書の要件に ID を振り、設計時点で検証方法を決める。実装前に行を追加し、PR で状態を更新する。
ID は `R-<章>.<節>-<連番>`。章・節は仕様書に合わせる。状態: `todo` / `red` / `green` / `manual-ok` / `n/a`。

最初の数行は書き方の例を兼ねる。章ごとに Issue を切る前に埋めていく。

## 4.1 コード規約（静的解析）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-4.1-1 | `index.html` は 128 KiB 以下（gzip 前、UTF-8 バイト数）。超過は拒否 | unit | ちょうど上限 / +1 バイト / 日本語（バイト数で数える） | `packages/domain/test/static-check.spec.ts` | green |
| R-4.1-2 | spec#4.1 の禁止 API・時間・乱数の識別子を字句レベルで検出し拒否する。一覧はデータファイル（`forbidden-identifiers.ts`）に持ち、全項目にテスト例がある。コメント・文字列・プロパティ名・識別子の一部は誤検出しない。`<script>` と `on*` 属性を検査する | unit | 全項目の代表例、`location` の代入と参照の区別、誤検出 10 例、行番号 | 同上 | green |
| R-4.1-3 | `<title>` 必須（空白のみは拒否） | unit | 欠落 / 空白のみ / 前後の空白除去 | 同上 | green |
| R-4.1-4 | `src` / `href` / `url()` / `@import` は `./assets/<name>` と `/lib/<name>@<version>.min.js` のみ。外部 URL・`data:`・相対パス越えは拒否 | unit | 受理 6 例 / 拒否 10 例 | 同上 | green |
| R-4.1-5 | DOM イベント直接購読・`onStart` 前の音声再生・画面サイズは警告（拒否しない） | unit | — | 同上 | todo |

## 5.3 Content-Security-Policy（#21 でパス分けに改訂）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.3-1 | ゲーム配信の全レスポンス（HTML・アセット・404 含む）に CSP `sandbox allow-scripts` が付く | integration | Miniflare で `/p/<id>/`、`/p/<id>/assets/x`、存在しないパスを取得し、ヘッダを検査 | `apps/games/test/integration/csp.spec.ts` | todo |
| R-5.3-2 | CSP の各ソースは自投稿パス `/p/<post_id>/` と `/lib/` だけを指し、他投稿のパスを含まない | integration + e2e | integration: 投稿 A の CSP に投稿 B のパスが含まれない。e2e: 投稿 A のゲームから `/p/B/assets/` を読むと CSP 違反になる | `apps/games/test/integration/csp.spec.ts`、`apps/web/e2e/sandbox.spec.ts` | todo |
| R-5.3-3 | ゲーム URL を直接開いても不透明オリジンで動く（`origin === "null"`、`localStorage` が例外） | e2e | Playwright でゲーム URL をトップレベルで開き、`self.origin` と `localStorage` を確かめる | `apps/web/e2e/sandbox.spec.ts` | todo |
| R-5.3-4 | 配信 Worker はリダイレクトを返さない（CSP のパス照合がリダイレクト後に効かないため） | integration | 末尾スラッシュなし等で 3xx が返らない | `apps/games/test/integration/csp.spec.ts` | todo |

## 6.1 メッセージプロトコル

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-6.1-1 | Host/Guest ともにメッセージを JSON スキーマで検証し、違反は即セッション破棄 | contract | 余計なフィールド・型違い・未知の type を送り、相手が DESTROYED に遷移する | `packages/sdk/test/contract/schema.spec.ts` | todo |
| R-6.1-2 | `ready` より前の Host 送信は無視される | contract | `init` を先に送ってから `ready`、Guest が `init` を再要求しないこと | 同上 | todo |
| R-6.1-3 | `end` は 1 セッションに 1 回。2 回目以降は捨てる | unit | 状態機械に `end` を 2 回入れ、2 回目が拒否される | `packages/domain/test/session.spec.ts` | green |
| R-6.1-4 | `media` は kind ごとに 1 セッション 1 回、サイズ上限（thumb 64KB、video 2MB） | unit + integration | unit: 2 回目拒否と上限超過拒否。integration: 実 iframe から上限超の blob を送り破棄される | `packages/domain/test/session.spec.ts`、`packages/sdk/test/integration/media.spec.ts` | green（unit）/ todo（integration） |
| R-6.1-5 | spec#6.1 の 10 種を方向別のスキーマで検証する。余計なフィールド・型違い・未知の type・方向違い・`media` の上限超過と MIME 違反を拒否。`ready` の `verb` / `input` / `duration` は静的解析と同じ定数（`VERB_MAX_CHARS`、`ACCEPTED_INPUTS`、`DURATION_MIN/MAX`）、`end.score` は spec#10.4 の上限。検証済み Guest メッセージは `SessionEvent` に 1 対 1 で変換できる | unit | 各型の正例 1 つ、余計なフィールド、型違い、未知の type、境界値（duration 179/180/480/481、verb 0/8/9 文字、score 2^31−1/+1、thumb 64KB/+1、video 2MB/+1）、replay で inputs 欠落 | `packages/sdk/test/messages.spec.ts` | green |

## 6.3 ミクロゲーム契約

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-6.3-1 | `gf:duration` は 180〜480。範囲外・欠落は静的解析で拒否 | unit | 179 / 180 / 480 / 481 / 欠落 / 非数 | `packages/domain/test/static-check.spec.ts` | green |
| R-6.3-2 | `gf:verb` は 1〜8 文字 | unit | 0 / 1 / 8 / 9 文字、絵文字を含む場合 | 同上 | green |
| R-6.3-3 | `gf:input` は tap / hold / swipe のいずれか（MVP は tilt 拒否） | unit | 各値と `tilt`、未知の値 | 同上 | green |
| R-6.3-4 | 時間切れ時、SDK は `onTimeout` の戻り値で `end` を自動送信（既定 lose） | contract | 最小 Host で `time_limit` フレーム進め、`end{result}` が 1 回届く | `packages/sdk/test/contract/timeout.spec.ts` | todo |
| R-6.3-5 | ゲームは `onStart` 直後から操作可能（タイトル画面を置かない） | manual | サンプル 30 本を実機で通し、開始遅延を感じる本を記録 | `docs/manual-tests/microgame-tempo.md` | todo |

## 6.4 Host 状態機械

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-6.4-1 | 監視タイマー満了で RUNNING/PAUSED → ENDED(lose)。以後同 session の `end` は捨てる | unit + formal | unit: 手動時計で満了させ、遅れて `end` を入れて拒否。formal: spec#13.7 P11, P12 | `packages/domain/test/session.spec.ts`、`spec/tla/Session.tla` | green |
| R-6.4-2 | PAUSED 中はタイマーが進まない | unit | pause → 時計を進める → resume → 残り時間が減っていない | 同上 | green |
| R-6.4-3 | `end` は RUNNING と PAUSED で受理、INITED では拒否 | unit | 遷移表の網羅 | 同上 | green |

## 8.2 ゲーム間の遷移

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-8.2-1 | RUNNING(play) の Guest は同時に 1 つ | unit + formal + e2e | unit: ラン状態機械。formal: F1。e2e: 10 本完走中に RUNNING が常に 1 | `packages/domain/test/run.spec.ts`、`apps/web/e2e/run.spec.ts` | todo |
| R-8.2-2 | 幕間の延長は最大 3 秒、超えたら lose 扱いで飛ばす | unit | 手動時計で 3 秒経過、次ゲームが LOADING のまま → 結果 lose、次へ | `packages/domain/test/run.spec.ts` | todo |
| R-8.2-3 | iframe は最大 3 枚 | integration | Playwright で DOM 上の iframe 数を各遷移で数える | `apps/web/e2e/run.spec.ts` | todo |
| R-8.2-4 | 幕間 1.0 秒・結果 0.5 秒のテンポ | manual | 実機で自分と大学生が試し、感想を記録（spec#15 (a)） | `docs/manual-tests/run-tempo.md` | todo |

## 9 MCP

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-9-1 | OAuth 2.1 の DCR・PKCE・`.well-known` を提供する | integration | MCP 公式 SDK のクライアントで DCR → 認可 → トークン → `tools/list` まで通す | `apps/api/test/integration/mcp-oauth.spec.ts` | todo |
| R-9-2 | Muse のカスタムコネクタから接続し、`publish_game` が通る | manual | iPhone の Muse に接続プロンプトを貼る。計画書 W1 PoC | `docs/manual-tests/muse-connect.md` | todo |
| R-9-3 | 契約に合わない HTML は `publish_game` が拒否し、修正方法をエラーに含める | integration | 範囲外 duration の HTML を送り、エラー文に「180〜480」が含まれる | `apps/api/test/integration/publish.spec.ts` | todo |
| R-9-4 | 新規投稿は 5 件/日まで | integration | 6 件目が拒否される。日付境界は手動時計 | 同上 | todo |
