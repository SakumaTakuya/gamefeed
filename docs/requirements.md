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

## 5.1 オリジン設計

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.1-1 | ゲームは配信オリジン `<games-origin>/p/<post_id>/` からのみ配信され、アプリのオリジンでゲーム HTML が返らない | integration + manual | `app.request("/p/x/")` がゲーム HTML を返さない。PT-5.1-1 | `apps/api/test/integration/no-games.spec.ts`、`docs/manual-tests/sandbox-pentest.md` | todo |
| R-5.1-2 | 配信オリジンは `Set-Cookie` を一切返さない（HTML・アセット・404） | integration + manual | R-5.3-1 と同じ 3 パスでヘッダを検査。PT-5.1-2 | `apps/games/test/integration/csp.spec.ts`、同上 | todo |
| R-5.1-3 | ゲーム URL の組み立ては Host の 1 関数に閉じ、サブドメイン方式へ設定だけで戻せる | manual | PT-5.1-3（grep で 1 か所） | 同上 | todo |

## 5.2 iframe sandbox 属性

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.2-1 | Host の iframe は `sandbox="allow-scripts"` のみ。`allow-same-origin` / `allow-popups` / `allow-top-navigation` / `allow-forms` / `allow-modals` / `allow-pointer-lock` を付けない | e2e + manual | 攻撃 HTML（PT-5.2-1〜6）で `localStorage` / `window.open` / `top.location` / form 送信 / `alert` / pointer lock がすべて遮断。DOM の `sandbox` 属性値を assert | `apps/web/e2e/sandbox.spec.ts`、`docs/manual-tests/sandbox-pentest.md` | todo |
| R-5.2-2 | `allow="accelerometer 'src'; gyroscope 'src'"`、`referrerpolicy="no-referrer"`、`credentialless` | e2e + manual | PT-5.2-7〜9。カメラ・位置情報が `NotAllowedError`、`Referer` が空 | 同上 | todo |

## 5.3 Content-Security-Policy（#21 でパス分けに改訂）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.3-1 | ゲーム配信の全レスポンス（HTML・アセット・404 含む）に CSP `sandbox allow-scripts` が付く | integration | Miniflare で `/p/<id>/`、`/p/<id>/assets/x`、存在しないパスを取得し、ヘッダを検査 | `apps/games/test/integration/csp.spec.ts`、PT-5.3-1 | todo |
| R-5.3-2 | CSP の各ソースは自投稿パス `/p/<post_id>/` と `/lib/` だけを指し、他投稿のパスを含まない | integration + e2e | integration: 投稿 A の CSP に投稿 B のパスが含まれない。e2e: 投稿 A のゲームから `/p/B/assets/` を読むと CSP 違反になる | `apps/games/test/integration/csp.spec.ts`、`apps/web/e2e/sandbox.spec.ts`、PT-5.3-2 | todo |
| R-5.3-3 | ゲーム URL を直接開いても不透明オリジンで動く（`origin === "null"`、`localStorage` が例外） | e2e | Playwright でゲーム URL をトップレベルで開き、`self.origin` と `localStorage` を確かめる | `apps/web/e2e/sandbox.spec.ts`、PT-5.3-3 | todo |
| R-5.3-4 | 配信 Worker はリダイレクトを返さない（CSP のパス照合がリダイレクト後に効かないため） | integration | 末尾スラッシュなし等で 3xx が返らない | `apps/games/test/integration/csp.spec.ts`、PT-5.3-4 | todo |

## 5.4 脅威モデル（侵入テスト項目）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.4-1 | ゲームから Host の DOM・Cookie・他 iframe に触れない（`parent.document`、`top.document.cookie`、`top.frames[n].document`、`document.domain` 緩和） | e2e + manual | PT-5.4-1, PT-5.4-6, PT-5.4-7 がすべて `SecurityError` | `apps/web/e2e/sandbox.spec.ts`、`docs/manual-tests/sandbox-pentest.md` | todo |
| R-5.4-2 | 外部へのデータ送信（`fetch` / `sendBeacon` / `WebSocket` / `EventSource` / `<img>` / XHR / `import()` / DNS プリフェッチ）が遮断される | e2e + manual | PT-5.4-2, PT-5.4-3, PT-5.3-7。外部ドメインへのリクエストが 1 つも出ない | 同上 | todo |
| R-5.4-3 | `blob:` / `data:` へのナビゲーションで sandbox を抜けられない | e2e + manual | PT-5.4-4。遷移しないか、遷移先も `origin === "null"` | 同上 | todo |
| R-5.4-4 | Service Worker を登録できない | e2e + manual | PT-5.4-5 が `SecurityError` | 同上 | todo |
| R-5.4-5 | Host の UI（幕間・結果・ヘッダー）は iframe の上のレイヤで、ゲームが全画面を偽装できない | manual | PT-5.4-8 | `docs/manual-tests/sandbox-pentest.md` | todo |
| R-5.4-6 | Host は `X-Frame-Options: DENY` を返す | integration + manual | `app.request("/")` のヘッダ。PT-5.4-14 | `apps/api/test/integration/headers.spec.ts`、同上 | todo |
| R-5.4-7 | Host は `event.source === iframe.contentWindow`、Guest は `event.source === window.parent` で送り元を照合し、他からのメッセージを捨てる | contract + manual | PT-5.4-9, PT-5.4-10。第三者ページからの `end` / `init` で状態が動かない | `packages/sdk/test/contract/schema.spec.ts`、同上 | todo |
| R-5.4-8 | 無限ループ・巨大 canvas・音量爆弾で Host のページが巻き込まれない | manual | PT-5.4-11〜13 | `docs/manual-tests/sandbox-pentest.md` | todo |

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
| R-9-1 | OAuth 2.1 の DCR・PKCE・`.well-known`（RFC 8414 / 9728、issuer 配下とパス挿入形の両方）を提供する | integration | MCP 公式 SDK（v2）のクライアントで DCR → 認可 → 同意 → トークン → `tools/list` → `publish_game`（ダミー）まで通す。トークンなしの `POST /api/mcp` は 401 と `WWW-Authenticate`（`resource_metadata`） | `apps/api/test/integration/mcp-oauth.spec.ts` | green |
| R-9-2 | Muse のカスタムコネクタから接続し、`publish_game` が通る。Claude のカスタムコネクタでも同じ | manual | iPhone の Muse に接続プロンプトを貼る。計画書 W1 PoC（MC-1〜MC-4） | `docs/manual-tests/muse-connect.md` | green（Muse、2026-11-05）/ todo（Claude） |
| R-9-5 | アクセストークンは 24 時間以上、リフレッシュトークンは 30 日。ローテーション後の旧リフレッシュトークンは猶予内なら同じ応答を返す（計画書 第5節「トークン方針」） | integration + manual | `expires_in ≥ 86400`、`refresh_token` あり。旧トークンで 2 回目の refresh が 200 で同じ応答。24 時間以上空けた再接続は MC-5 | `apps/api/test/integration/mcp-oauth.spec.ts`、`docs/manual-tests/muse-connect.md` | green（integration）/ todo（manual） |
| R-9-3 | 契約に合わない HTML は `publish_game` が拒否し、修正方法をエラーに含める | integration | 範囲外 duration の HTML を送り、エラー文に「180〜480」が含まれる | `apps/api/test/integration/publish.spec.ts` | todo |
| R-9-4 | 新規投稿は 5 件/日まで | integration | 6 件目が拒否される。日付境界は手動時計 | 同上 | todo |

## 12.1 テーブル

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-12.1-1 | spec#12.1 の 10 テーブルと spec#12.4 の `themes` / `runs`、列挙型 10 種（値は記載順）がマイグレーションで作られ、再適用は何もしない | integration | 空の Postgres に `migrateDb` を当て `information_schema` / `pg_enum` を見る。2 回目も成功 | `apps/api/test/integration/db.spec.ts` | green |
| R-12.1-2 | `users.handle`、`reports(post_id, reporter_id)`、`post_assets(post_id, name)` は一意 | integration | 同じ値を 2 回入れて unique 違反 | 同上 | green |
| R-12.1-3 | `posts.parent_id` は `posts.id` への外部キー。子がある投稿は削除できない（RESTRICT） | integration | 子を持つ親の DELETE と、存在しない親の INSERT が FK 違反 | 同上 | green |
| R-12.1-4 | `sessions.submitted_at` は `state = submitted` のときだけ非 NULL（CHECK）。`score` は 0 以上（spec#10.4） | integration | open で NULL は受理、submitted で NULL / open で非 NULL / score −1 は拒否 | 同上 | green |
| R-12.1-5 | 表示用 `status` はビュー `post_status` で導出。`removed` / `expired` / `pending` はそのまま、`indiv_restricted` または祖先（自身含む）が `tree_locks` の根なら `restricted`、それ以外は `base_status` | integration | 深さ 3 のツリーで根をロックすると子孫も `restricted`、ロック削除で戻る。`removed` に `indiv_restricted` を立てても `removed` | 同上 | green |

## 12.2 不変条件

I2・I3（ユーザー側）・I6〜I9 はアプリのトランザクションで担保するもので、DB の制約では書けない。該当する API を実装する Issue で状態を更新する。

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-12.2-1 | I1: `posts.parent_id` は挿入後に変更できない（トリガー。NULL への変更も拒否） | integration | 別の親 / NULL への UPDATE がエラー文 `parent_id` 付きで拒否。他の列の UPDATE は通る | `apps/api/test/integration/db.spec.ts` | green |
| R-12.2-2 | I2: 子の `tree_id` は親と同じ、`depth` は親 + 1。挿入時に親行を `FOR SHARE` でロックして計算する | integration | `publish_game` のトランザクションで親を同時に更新しても一貫する | `apps/api/test/integration/publish.spec.ts` | todo |
| R-12.2-3 | I3: `tree_locks.action_id` は `moderation_actions` を必ず指す（FK）。BAN されたユーザーの投稿がすべて `removed` になるのは同一トランザクションで担保（`users` を `FOR SHARE`） | integration | FK: 監査行のない `tree_locks` が拒否される（green）。BAN 側はモデレーション API の Issue で（todo） | 同上 / `apps/api/test/integration/moderation.spec.ts` | green（FK）/ todo（BAN） |
| R-12.2-4 | I4: `base_status` が `limited` / `public` なら `showcase_key` は非 NULL（CHECK） | integration | `showcase_key` NULL のまま `limited` / `public` にすると拒否。`pending` は NULL 可 | `apps/api/test/integration/db.spec.ts` | green |
| R-12.2-5 | I5: `removed` / `expired` からの `base_status` 変更は存在しない（トリガー） | integration | `removed` / `expired` → `public` が拒否。`removed` のまま他の列の更新は通る | 同上 | green |
| R-12.2-6 | I6: `restricted` からの復帰は `moderation_actions.kind = restore / restore_tree` を伴う | integration | モデレーション API が監査行と状態変更を同一トランザクションで書く | `apps/api/test/integration/moderation.spec.ts` | todo |
| R-12.2-7 | I7: 1 セッションの `submitted` 遷移は高々 1 回（`UPDATE … WHERE state = 'open'` の更新行数で判定） | integration | 同じ `session_id` への 2 回目の `PUT /sessions/{id}/result` が 409 | `apps/api/test/integration/sessions.spec.ts` | todo |
| R-12.2-8 | I8: `verdict = accepted` なら `score` と `checkpoint` が再実行結果と一致（検証ワーカーだけが `accepted` を書く）。DB ロールの分離は MVP 外 | integration | Phase 2 の検証ワーカーで。MVP では `accepted` を書く経路が検証ワーカーのみであることをコードで確認 | — | n/a（MVP） |
| R-12.2-9 | I9: 投稿の `post_assets` は合計 3 MB・32 件以下、`required` 合計 512 KB 以下、BGM は `required` 不可 | integration | `publish_game` のトランザクションで集計して拒否 | `apps/api/test/integration/publish.spec.ts` | todo |

## 12.4 ミクロゲーム対応の追加分

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-12.4-1 | `games.duration_frames` は 180〜480（CHECK）。`verb` / `input` / `duration_frames` は静的解析前は NULL 可。`games.theme_id` は `themes` への外部キーで NULL は「フリー」 | integration | 180 / 480 受理、179 / 481 拒否、全部 NULL 受理、存在しない `theme_id` 拒否 | `apps/api/test/integration/db.spec.ts` | green |
| R-12.4-2 | `runs.cleared ≤ runs.total`、`results` の長さ ≤ `total`、`results` は `win` / `lose` のみ（CHECK） | integration | 境界（= total、空）受理、超過と `draw` 拒否 | 同上 | green |
| R-12.4-3 | `limited` / `public` にする投稿のゲームは `verb`・`input` が非 NULL（トリガー） | integration | `verb` NULL のゲームを `public` にするとエラー文 `verb` / `input` 付きで拒否。揃っていれば通る | 同上 | green |
| R-12.4-4 | ビュー `run_results`: お題ごとに `runs`、`clear_rate = Σcleared / Σtotal`、`completion_rate = ended_at 非 NULL の割合` | integration | 2 ラン（3/4 クリア完走、0/4 未完走）で 3/8 と 1/2 | 同上 | green |
