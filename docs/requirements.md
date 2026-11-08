# 要件→テスト対応表

仕様書の要件に ID を振り、設計時点で検証方法を決める。実装前に行を追加し、PR で状態を更新する。
ID は `R-<章>.<節>-<連番>`。章・節は旧 `spec.md` に合わせて振ったもので、ID 自体はテスト名から参照されるので変えない。2026-11-06 の文書分割（#43）以降、見出しは新文書の節を指し、要件の本文は新文書に合わせて直す。新しく足す行は `R-<文書略号>.<節>-<連番>`（例: `R-gc.A3-1`。gc = game-contract）。状態: `todo` / `red` / `green` / `manual-ok` / `n/a`。

最初の数行は書き方の例を兼ねる。章ごとに Issue を切る前に埋めていく。

## game-contract A.2 / A.5 / A.11 コードと静的検査（旧 4.1）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-4.1-1 | `index.html` は 128 KiB 以下（gzip 前、UTF-8 バイト数）。超過は拒否 | unit | ちょうど上限 / +1 バイト / 日本語（バイト数で数える） | `packages/domain/test/static-check.spec.ts` | green |
| R-4.1-2 | gc#A.5 の禁止 API・時間・乱数の識別子を字句レベルで検出し拒否する。一覧はデータファイル（`forbidden-identifiers.ts`）に持ち、全項目にテスト例がある。コメント・文字列・プロパティ名・識別子の一部は誤検出しない。`<script>` と `on*` 属性を検査する | unit | 全項目の代表例、`location` の代入と参照の区別、誤検出 10 例、行番号 | 同上 | green |
| R-4.1-3 | `<title>` 必須（空白のみは拒否） | unit | 欠落 / 空白のみ / 前後の空白除去 | 同上 | green |
| R-4.1-4 | `src` / `href` / `url()` / `@import` は `./assets/<name>` と `/lib/<name>@<version>.min.js` のみ。外部 URL・`data:`・相対パス越えは拒否 | unit | 受理 6 例 / 拒否 10 例 | 同上 | green |
| R-4.1-5 | 入力の直接購読（`DIRECT_INPUT`）、`GF.score` への代入も `GF.end()` もない（`NO_SCORE`）、自前の viewport（`VIEWPORT`）は警告（拒否しない）。gc#A.11 | unit | 各警告の有無 3 例ずつ | 同上 | todo |
| R-gc.A3-1 | `gf:target` は 1 以上の整数。欠落・0・非数は `META_TARGET` で拒否 | unit | 欠落 / 0 / 1 / 非数 / 小数 | 同上 | todo |
| R-gc.A2-1 | `<form>` / `<iframe>` / `<object>` / `<embed>` は拒否（gc#A.5） | unit | 各要素 1 例 | 同上 | todo |

## security A.2 オリジンと Cookie（旧 5.1）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.1-1 | ゲームは配信オリジン `<games-origin>/p/<post_id>/` からのみ配信され、アプリのオリジンでゲーム HTML が返らない | integration + manual | `app.request("/p/x/")` がゲーム HTML を返さない。PT-5.1-1 | `apps/api/test/integration/no-games.spec.ts`、`docs/manual-tests/sandbox-pentest.md` | todo |
| R-5.1-2 | 配信オリジンは `Set-Cookie` を一切返さない（HTML・アセット・404） | integration + manual | R-5.3-1 と同じ 3 パスでヘッダを検査。PT-5.1-2 | `apps/games/test/integration/csp.spec.ts`、同上 | todo |
| R-5.1-3 | ゲーム URL の組み立ては Host の 1 関数に閉じ、サブドメイン方式へ設定だけで戻せる | manual | PT-5.1-3（grep で 1 か所） | 同上 | todo |

## security A.3 iframe（旧 5.2）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.2-1 | Host の iframe は `sandbox="allow-scripts"` のみ。`allow-same-origin` / `allow-popups` / `allow-top-navigation` / `allow-forms` / `allow-modals` / `allow-pointer-lock` / `allow-downloads` を付けない（se#A.3） | e2e + manual | 攻撃 HTML（PT-5.2-1〜6）で `localStorage` / `window.open` / `top.location` / form 送信 / `alert` / pointer lock がすべて遮断。DOM の `sandbox` 属性値を assert | `apps/web/e2e/sandbox.spec.ts`、`docs/manual-tests/sandbox-pentest.md` | todo |
| R-5.2-2 | `allow` を付けない（tilt は保留、se#B.6）、`referrerpolicy="no-referrer"`、`credentialless`。`draft` の `src` には `?t=<試遊トークン>` | e2e + manual | PT-5.2-7〜9。カメラ・位置情報・加速度が `NotAllowedError` または発火しない、`Referer` が空 | 同上 | todo |

## security A.4 配信レスポンスのヘッダ（旧 5.3。#21 でパス分けに改訂）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-5.3-1 | ゲーム配信の全レスポンス（HTML・アセット・404・405 含む）に se#A.4 の CSP（`sandbox allow-scripts` を含む）、`Cross-Origin-Resource-Policy: cross-origin`、`nosniff`、`Referrer-Policy: no-referrer` が付く | integration | Miniflare で `/p/<id>/`、`/p/<id>/assets/x`、存在しないパス、`POST` を取得し、ヘッダを検査 | `apps/games/test/integration/csp.spec.ts`、PT-5.3-1 | todo |
| R-5.3-2 | CSP の各ソースは自投稿パス `/p/<post_id>/` と `/lib/` だけを指し、他投稿のパスを含まない | integration + e2e | integration: 投稿 A の CSP に投稿 B のパスが含まれない。e2e: 投稿 A のゲームから `/p/B/assets/` を読むと CSP 違反になる | `apps/games/test/integration/csp.spec.ts`、`apps/web/e2e/sandbox.spec.ts`、PT-5.3-2 | todo |
| R-5.3-3 | ゲーム URL を直接開いても不透明オリジンで動く（`origin === "null"`、`localStorage` が例外） | e2e | Playwright でゲーム URL をトップレベルで開き、`self.origin` と `localStorage` を確かめる | `apps/web/e2e/sandbox.spec.ts`、PT-5.3-3 | todo |
| R-5.3-4 | 配信 Worker はリダイレクトを返さない（CSP のパス照合がリダイレクト後に効かないため） | integration | 末尾スラッシュなし等で 3xx が返らない | `apps/games/test/integration/csp.spec.ts`、PT-5.3-4 | todo |

## security A.7 脅威モデル（旧 5.4。侵入テスト項目）

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
| R-5.4-9 | Guest が自分の iframe を遷移させたら、Host は 2 回目以降の `load` で即 `destroy` し、手番を `via: error` で終える（se#A.3） | e2e + manual | PT-5.4-16。`location.href` と `meta refresh` の 2 通りで、`load` の後に iframe が消え、セッションが ENDED(error) | `apps/web/e2e/sandbox.spec.ts`、同上 | todo |

## mcp A.2 / A.3 / A.5 / A.6 / A.7 / A.10 サーバ・ツール・users 行・処理順・同一内容・エラー（旧 9）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-mc.A3-1 | `tools/list` は `publish_game` / `list_my_games` / `unpublish_game` の 3 本、`resources/list` は `gf://guide` の 1 つだけ。`gf://guide` の本文は `game-contract.md` の A 部と一致する | integration | MCP クライアントで一覧を取り、名前の集合を比べる。リソース本文とリポジトリのファイルの差分が空 | `apps/api/test/integration/mcp-tools.spec.ts` | todo |
| R-mc.A3-2 | `publish_game` の出力は `{post_id, status, url, warnings, reused}`。`draft` なら `url` は `<app-origin>/draft/<post_id>`、公開後は `/g/<post_id>`。`list_my_games` は最新 50 件で mc#A.3 の項目、`restricted` には `restricted_reason` | integration | 下書き・公開・制限の 3 状態で呼ぶ | 同上 | todo |
| R-mc.A5-1 | 初回のツール呼び出しと「作る」ページのログインで `users` 行ができる（`trust_score` 10、`active`）。`handle` は mc#A.5 の slug 規則で一意。空・3 文字未満・非ラテンは `user-<id 末尾 6>`。衝突は `-2`, `-3` | unit + integration | `handle` の生成を表で（`"Taku Sakuma"` → `taku-sakuma`、`"佐久間"` → `user-xxxxxx`、`"a"` → `user-xxxxxx`、同名 2 人目 → `-2`）。`auth_user` だけのユーザーで `list_my_games` を呼ぶと行ができる | `packages/domain/test/handle.spec.ts`、同上 | todo |
| R-mc.A6-1 | `publish_game` の処理順（mc#A.6）: 拒否なら何も書かない。DB コミット後に R2、成功で `games.stored_at`、その後に KV。R2 失敗は `storage_failed` で、同じ入力の再呼び出しが同一内容で同じ投稿に戻り R2 だけやり直す | integration | fake の R2 を失敗させて `games` / `posts` は残り `stored_at` NULL、KV は書かれない。2 回目で `stored_at` が入り KV が書かれる | 同上 | todo |
| R-mc.A7-1 | 同一内容（mc#A.7）: `post_id` なしで同じ `game_hash` が自分の `draft` にあれば同じ `post_id`（`reused: true`）で `title` / `prompt` を更新、公開済み・`unpublished` ならその `status` で変更なしで返す、`removed` なら `invalid_state`。上限と静的検査より先に見るので、上限に達していても通る | integration | 同じ HTML を 2 回・3 回送る。10 件・当日の上限に達した状態で同じ HTML を送っても `reused: true`。`unpublished` の内容を送ると `status: unpublished` | 同上 | todo |
| R-mc.A10-1 | エラーは `isError: true` と `structuredContent.{code, message, errors?, reason?}`。他人の `post_id` と存在しない `post_id` は同じ `not_found` 応答 | integration | 各 `code` を 1 つずつ起こす。2 つの `not_found` の `structuredContent` が等しい | 同上 | todo |
| R-mc.A9-1 | 公開直後のジョブが決定論ハーネスを 1 回実行し、`thumb_key` と `preview_key` を入れる。固まる・例外・`GF.timeLimit` を過ぎても終わらないゲームは `thumb_key` を入れず `calibration = invalid`（`GF.end()` なしで時間切れは正常）。`thumb_key` が NULL の間は `post_eligibility = none` | integration + manual | fake のハーネスで成功・時間切れで正常終了・固まる・例外の 4 通り。実行環境は plan#2 で決めてから manual | `apps/api/test/integration/publish-job.spec.ts` | todo |

## security A.5 / A.6 / A.8 / A.9 配信可否・試遊トークン・アプリのヘッダ・ライブラリ（新規）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-se.A5-1 | 配信 Worker は KV `serve:<post_id>` が `ok` のときだけ配信し、`no` / 未知 / `draft`（トークンなし）は同じ文言の 404。`Cache-Control` は `draft` が `no-store`、`ok` が `public, max-age=60`、`/lib/` が `immutable` | integration | Miniflare に KV を 3 状態で置いて `/p/<id>/` を取得。本文とヘッダ | `apps/games/test/integration/serve.spec.ts` | todo |
| R-se.A5-2 | 試遊トークンは `draft` の作者にだけ発行され（他は `not_found`）、Worker は HMAC・`post_id` の一致・`exp` を検証する。期限切れ・別の `post_id`・改ざんは 404。公開後の投稿では `?t=` を無視する | integration | API: 作者 / 他人 / `public` の投稿で `play-token` を呼ぶ。Worker: 正しいトークン、10 分 + 1 秒後、別 ID、署名 1 バイト改変 | `apps/api/test/integration/play-token.spec.ts`、`apps/games/test/integration/serve.spec.ts` | todo |
| R-se.A5-3 | se#A.5 の遷移（公開・置き換え・非公開・再公開・運営の操作・自動制限・下書きの削除）のたびに KV が書かれ、ツリー制限は子孫全員分。日次の突き合わせでずれが直る | integration | fake の KV クライアントで各遷移後の値を見る。突き合わせジョブが欠けたキーを書く | `apps/api/test/integration/serve-kv.spec.ts` | todo |
| R-se.A6-1 | アプリのオリジンは se#A.6 の CSP（`frame-src` は配信オリジンだけ、`frame-ancestors 'none'`）と `Referrer-Policy`、`nosniff` を返す | integration | `app.request("/")` と `/api/connect/sign-in` のヘッダ | `apps/api/test/integration/headers.spec.ts` | todo |
| R-se.A8-1 | 運営の操作（`moderation.md` A.7）は `MODERATOR_IDS` に含まれるユーザーだけが呼べ、他は `forbidden` | integration | 運営 / 一般 / 未ログインで `restrict` を呼ぶ | `apps/api/test/integration/moderation.spec.ts` | todo |
| R-se.A9-1 | `/lib/` は `apps/games/lib/manifest.json` にある `name@version` だけを返し、CI が R2 のファイルの `sha256` と一致を確かめる。静的検査は同じファイルで照合する | integration + unit | 一覧にない `@version` が 404。`manifest.json` を書き換えると静的検査の受理が変わる | `apps/games/test/integration/lib.spec.ts`、`packages/domain/test/static-check.spec.ts` | todo |

## protocol A.2 / A.3 / A.9 ワイヤ形式とメッセージ（旧 6.1）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-6.1-1 | Host/Guest ともにメッセージを JSON スキーマで検証し、違反は即セッション破棄 | contract | 余計なフィールド・型違い・未知の type を送り、相手が DESTROYED に遷移する | `packages/sdk/test/contract/schema.spec.ts` | todo |
| R-6.1-2 | `ready` より前の Host 送信は無視される | contract | `init` を先に送ってから `ready`、Guest が `init` を再要求しないこと | 同上 | todo |
| R-6.1-3 | `end` は 1 セッションに 1 回。2 回目以降は捨てる | unit | 状態機械に `end` を 2 回入れ、2 回目が拒否される | `packages/domain/test/session.spec.ts` | green |
| R-6.1-4 | `media` は廃止（pr#B.1）。Guest からバイナリを受け取る経路を持たない | unit | スキーマが `media` を未知の type として拒否する | `packages/sdk/test/messages.spec.ts` | red（実装は `media` を受理する） |
| R-6.1-5 | pr#A.3 の 9 種（Guest: ready / log / end / error、Host: init / start / pause / resume / destroy）を方向別のスキーマで検証する。余計なフィールド・型違い・未知の type・方向違いを拒否。`ready` の `verb` / `input` / `duration` / `target` は静的検査と同じ定数、`end.score` は 0〜2^31−1、`end.frames` ≤ `time_limit`、`init.speed` は 1.0〜1.5。`log.inputs` の kind は tap / hold / swipe / drag（`key` と `tilt` は拒否）。検証済み Guest メッセージは `SessionEvent` に 1 対 1 で変換できる | unit | 各型の正例 1 つ、余計なフィールド、型違い、未知の type、境界値（duration 179/180/600/601、verb 0/8/9 文字、target 0/1、score −1/0/2^31−1/+1、speed 0.99/1.0/1.5/1.51）、replay で inputs 欠落、`end.result` があると拒否 | `packages/sdk/test/messages.spec.ts` | red（実装は 10 種・result・key のまま） |
| R-pr.A2-1 | `ready.sdk` は `"2.0"`。Host は知らないメジャーを拒否してセッション破棄 | unit | `"1.1"` / `"2.0"` / `"3.0"` | 同上 | todo |
| R-pr.A9-1 | `log.from_frame` は厳密に増加。減る・重なる `log` は捨て、セッションを `flagged` にする。`end` 受理時に `log` の最大フレームが `end.frames` を超えないこと | unit | 増加 / 同値 / 減少の 3 列、`frames` 超えの `log` | `packages/domain/test/session.spec.ts` | todo |

## game-contract A.3 / A.4 / A.10 メタ宣言と SDK（旧 6.3）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-6.3-1 | `gf:duration` は 180〜600（gc#A.3）。範囲外・欠落は静的検査で拒否 | unit | 179 / 180 / 600 / 601 / 欠落 / 非数 | `packages/domain/test/static-check.spec.ts` | red（実装は 480 上限のまま） |
| R-6.3-2 | `gf:verb` は 1〜8 文字 | unit | 0 / 1 / 8 / 9 文字、絵文字を含む場合 | 同上 | green |
| R-6.3-3 | `gf:input` は tap / hold / swipe / drag / stick のいずれか（tilt は拒否）。gc#A.3 | unit | 各値と `tilt`、未知の値 | 同上 | red（実装は drag / stick を拒否する） |
| R-6.3-4 | 時間切れ時、SDK はそのときの `GF.score` で `end` を自動送信する。`GF.end()` は 1 回だけ効く（gc#A.4） | contract | 最小 Host で `time_limit` フレーム進め、`end{score}` が 1 回届く。`GF.end()` を 2 回呼んでも 1 回 | `packages/sdk/test/contract/timeout.spec.ts` | todo |
| R-gc.A4-1 | `GF.score` は整数・0 以上・2^31−1 以下に SDK がクランプする（gc#A.10） | unit | 負・小数・上限超・文字列 | `packages/sdk/test/score.spec.ts` | todo |
| R-gc.A4-2 | 入力イベントの座標は 0〜1 の正規化値。`tap` は `[x,y]`、`hold` は `[x,y,1|0]`、`swipe` は `[x0,y0,x1,y1]`、`drag` は `[x,y,1|0]` を 1/256 に量子化（gc#A.4） | contract | 実ブラウザで各入力を発生させ `onInput` の `data` を検証 | `packages/sdk/test/contract/input.spec.ts` | todo |
| R-gc.A4-3 | `stick` は SDK が描いて解釈する。原点は押した地点、最大半径は画面幅の 12%、デッドゾーン 15%、`GF.stick.{x,y,active}` が `onTick` ごとに更新される。`onInput` には `stick` イベントが来ない（gc#A.4） | contract | 実ブラウザで押下→移動→離すを再現し、各 tick の `GF.stick` とログの `drag` 列を検証。同じログから `GF.stick` 列が再現される | `packages/sdk/test/contract/stick.spec.ts` | todo |
| R-gc.A9-1 | 同じシードと同じ入力ログで `onDraw` なしに再実行すると同じ `GF.score` になる（gc#A.9） | contract | A.13 の例を 2 回実行して比較 | `packages/sdk/test/contract/determinism.spec.ts` | todo |
| R-6.3-5 | ゲームは `onStart` 直後から操作可能（タイトル画面を置かない） | manual | サンプル 30 本を実機で通し、開始遅延を感じる本を記録 | `docs/manual-tests/microgame-tempo.md` | todo |

## protocol A.5 / A.7 / A.8 Host 状態機械と監視タイマー（旧 6.4）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-6.4-1 | 監視タイマー満了で RUNNING → ENDED（`via: timeout`、`score: 0`、`frames: time_limit`）。以後同 session の `end` は捨てる。タイマーの長さは `time_limit ÷ (60 × speed)` 秒 ＋ 1.5 秒（pr#A.7） | unit + formal | unit: 手動時計で満了させ、遅れて `end` を入れて拒否。speed 1.0 と 1.5 で長さが変わる。formal: pr#A.12 P11, P12 | `packages/domain/test/session.spec.ts`、`verification/Session.tla` | red（実装は lose を返し、speed を見ない） |
| R-6.4-2 | PAUSED 中はタイマーが進まない | unit | pause → 時計を進める → resume → 残り時間が減っていない | 同上 | green |
| R-6.4-3 | `end` は RUNNING と PAUSED で受理、INITED では拒否。`error` も同じ状態で受理して ENDED（`via: error`、`score: 0`） | unit | 遷移表の網羅。`error` の結果に `score: 0` が入る | 同上 | red（実装は `error` に score を入れない） |
| R-pr.A4-1 | SDK は `start` から `time_limit ÷ (60 × speed)` 秒の壁時計が経過したら、フレームが足りなくても `end` を送る（`frames < time_limit`）。5 tick の追いつき上限は維持する（pr#A.4） | contract | rAF を 12 回/秒に絞った環境で speed 1.5・600 フレームのゲームを動かし、監視タイマー満了前に `end` が届き `frames < 600` | `packages/sdk/test/contract/slow-device.spec.ts` | todo |
| R-pr.A5-1 | PAUSED からの `init` は受理しない。ENDED からの `init` は受理する（pr#A.6） | unit | 遷移表の網羅 | 同上 | green |
| R-pr.A8-1 | `replay` の `init` には元のセッションと同じ `speed` を渡し、同じ `end.score` になる（pr#A.8） | contract | 実ブラウザで speed 1.0 と 1.5 の play を記録し、それぞれ同じ speed で replay | `packages/sdk/test/contract/replay-speed.spec.ts` | todo |
| R-pr.A10-1 | Guest はコールバックの例外で `error` を 1 回だけ送り、以後そのセッションで何も送らない。`end` の後の例外は無視する（pr#A.10） | contract | `onTick` で throw するゲームで `error` が 1 回、`end` の後に throw しても何も来ない | `packages/sdk/test/contract/error.spec.ts` | todo |

## run A.4 / A.5 / A.6 / A.7 スロットと手番の切り替え（旧 8.2）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-8.2-1 | RUNNING の Guest は同時に 1 つで、常に N（run#A.15 F1, F2） | unit + formal + e2e | unit: ラン状態機械。formal: F1, F2。e2e: 10 本完走中に RUNNING が常に 1 | `packages/domain/test/run.spec.ts`、`apps/web/e2e/run.spec.ts` | todo |
| R-8.2-2 | 幕間の延長は最大 3 秒（暫定、定数）。超えたら skip にして `destroy` し、N+2 を繰り上げる。skip は成績の分母に入らず残機も減らないが手番は消費する（run#A.5, A.6） | unit | 手動時計で 3 秒経過、次ゲームが LOADING のまま → skip、残機不変、手番 +1、N+2 が N に | `packages/domain/test/run.spec.ts` | todo |
| R-8.2-3 | iframe は最大 3 枚で、集合は常に N〜N+2 の部分集合。`start` は INITED のスロットにだけ送る（run#A.15 F3〜F5） | integration + formal | Playwright で DOM 上の iframe 数を各遷移で数える。formal: F3〜F5 | `apps/web/e2e/run.spec.ts`、`verification/Run.tla` | todo |
| R-run.A3-1 | ランの進行はサーバが持つ。`POST /runs/{id}/next` が手番（`post_id`, `session_id`, `seed`, `speed`, `is_new`, `lap`, `miss_below`）を発行し、上限か残機切れで `{done: true}` を返す。Host は `speed` をそのまま `init.speed` に渡す。`miss_below` は発行時点の分布から求め、セッションに凍結する（run#A.3） | unit + integration | unit: 山札 12・上限 50 で 51 回目が done、残機 0 で done、`miss_below` が発行後に分布が動いても変わらない。integration: API の応答を Host がそのまま init に渡す | `apps/api/test/runs.spec.ts`、`apps/web/e2e/run.spec.ts` | todo |
| R-run.A7-1 | ミスは Host が `end` の瞬間に `score < miss_below` で判定し、通信を待たない。`miss_below: null` と skip はミスにならない。3 回目のミスでその場でランが終わり `start` は出ない。サーバは同じ凍結値で判定し直し Host と一致する（run#A.5, A.7, A.15 F7, F8） | unit + formal | unit: 3 回目のミスで finish、`null` と skip は残機不変、`result` の応答が遅れても進行は変わらない。サーバ側: 同じ score と miss_below で同じ miss。formal: F7, F8 |
| R-run.A7-2 | `finish` は手番の順に結果を見て、3 回目のミス以降に発行された手番の結果を記録から捨てる。到達本数はサーバが決める（run#A.7, A.15 F9） | unit | 3 回目のミスの後に 2 手番ぶんの result を送っても到達本数が増えない | `apps/api/test/runs.spec.ts` | todo | `packages/domain/test/run.spec.ts`、`verification/Run.tla` | todo |
| R-run.A8-1 | 速度は 1/8 刻みの 5 値。エンドレスは周回 k で `min(1.5, 1 + 0.125k)`（暫定、定数）、デイリーは 1.0（run#A.8） | unit | k = 0〜5 の値、デイリーは常に 1.0 | `apps/api/test/runs.spec.ts` | todo |
| R-run.A15-1 | ランは必ず終わる。skip が続いても上限で終わる（run#A.15 F6） | formal + unit | formal: F6。unit: 全手番 skip で 50 回目に done | `verification/Run.tla`、`packages/domain/test/run.spec.ts` | todo |
| R-run.A2-1 | デイリーは同じ山札で何度でも遊べるが、保存される記録は初回だけ。2 回目以降は成績表を出すが `finish` で保存しない（run#A.2） | integration | 同じお題・同日に 2 回 finish し、記録が 1 つ | `apps/api/test/runs.spec.ts` | todo |
| R-run.A12-1 | 試遊ページは残機も成績表も持たず、同じ iframe に `init` し直して「もう一回」と速度変更ができる。作者のセッションは校正に数えない印を付けて送る（run#A.12） | e2e | 下書きで 2 回遊び、速度 1.5 に変えて 1 回。送られた result に作者印 | `apps/web/e2e/trial.spec.ts` | todo |
| R-8.2-4 | 幕間 1.0 秒・結果 0.5 秒のテンポ（暫定、定数）。周回ごとの速度上昇で平均的な遊ぶ側が 20〜30 本で終わるか | manual | 実機で自分と大学生が試し、感想と到達本数を記録 | `docs/manual-tests/run-tempo.md` | todo |

## scoring A.2 / A.5 / A.6 / A.7 / A.9 結果の受理・偏差値・校正（新規）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-sc.A2-1 | `PUT /sessions/{id}/result` は sc#A.2 の条件をすべて検査し、2 回目以降は 409、`frames` 超過・単調性違反・実時間超過は拒否して `flagged` | unit + integration | 各条件の境界 1 例ずつ。同じ id に 2 回送る | `apps/api/test/sessions.spec.ts` | todo |
| R-sc.A5-1 | 偏差値は sc#A.5 の手順（`p = (L + 0.5E + 0.5) ÷ (n + 1)`、Acklam の逆関数、小数 1 桁、20〜80）で、`verification/scoring_check.py` の S1〜S3、S5 と同じ値を返す | unit + formal | TS 実装と Python 参照実装を同じ分布で突き合わせる。S3: n=20 で 69.8、n=100 で 75.8 | `packages/domain/test/deviation.spec.ts`、`verification/scoring_check.py` | todo |
| R-sc.A6-1 | `miss_below` は発行時点の分布に対して偏差値が 40 以上になる最小の点数（A.5 と同じ計算、二分探索）。新しい結果について `score < miss_below` ⇔ 偏差値 < 40 が成り立つ（S4）。校正前・新作枠・デイリーは `null` | unit + formal | 正規・0 張り付き・二峰・長い尾・全件同点の 5 分布と、n = 20〜60 の境界で S4 | 同上 | todo |
| R-sc.A4-1 | 分布に入るのは `provisional` / `accepted`、`speed = 1.0`、`author = false`、`frames ≥ 0.9 × time_limit`、1 ユーザー直近 5 件までの結果。`timeout` / `error` は 0 として入る | unit | 各条件を外した結果が分布に入らない / 入る | `apps/api/test/distribution.spec.ts` | todo |
| R-sc.A7-1 | 校正状態は `n ≥ 20` で `uncalibrated → calibrated / invalid`。分散ゼロと 0 張り付き ≥ 80% で `invalid`、`invalid` は終端 | unit | 20 件目で遷移、19 件目では遷移しない、`invalid` から戻らない | `apps/api/test/calibration.spec.ts` | todo |
| R-sc.A8-1 | ランの出題は投稿状態 `public` かつ校正状態で決まる: `uncalibrated` は新作枠のみ、`calibrated` は正規枠、`review` / `invalid` は出ない | unit | 4 状態 × `public` / `limited` の組で山札を引く | `apps/api/test/runs.spec.ts` | todo |
| R-sc.A9-1 | `finish` の凍結値（手番ごとの偏差値、到達手番数、平均偏差値、記号列）は、その後に分布へ結果が足されても変わらない（S6） | integration | finish 後に同じゲームへ 100 件足し、runs の値を再読して比較 | `apps/api/test/runs.spec.ts` | todo |
| R-sc.A10-1 | 公開ボタンはハーネスで入力なしの play を speed 1.0 と 1.5 で実行し、監視タイマー内に `end` が届かないゲームの公開を拒否する | integration | `while(true)` のゲームが拒否され、A.13 の例が通る | `apps/api/test/publish-check.spec.ts` | todo |
| R-sc.A3-1 | 第 2 段階の再実行は上位 10 位・外れ値・校正前の無作為 5 件・`flagged` を対象にし、`score` 一致で `accepted`、不一致で `rejected`。`gf:deterministic="false"` は対象外で `flagged` のまま | integration | 対象の選び方 4 例、一致 / 不一致、非決定論の宣言 | `apps/api/test/verify.spec.ts` | todo |

## 9 MCP

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-9-1 | OAuth 2.1 の DCR・PKCE・`.well-known`（RFC 8414 / 9728、issuer 配下とパス挿入形の両方）を提供する | integration | MCP 公式 SDK（v2）のクライアントで DCR → 認可 → 同意 → トークン → `tools/list` → `publish_game`（ダミー）まで通す。トークンなしの `POST /api/mcp` は 401 と `WWW-Authenticate`（`resource_metadata`） | `apps/api/test/integration/mcp-oauth.spec.ts` | green |
| R-9-2 | Muse のカスタムコネクタから接続し、`publish_game` が通る。Claude のカスタムコネクタでも同じ | manual | iPhone の Muse に接続プロンプトを貼る。計画書 W1 PoC（MC-1〜MC-4） | `docs/manual-tests/muse-connect.md` | green（Muse・Claude、2026-11-05） |
| R-9-5 | アクセストークンは 24 時間以上、リフレッシュトークンは 30 日。ローテーション後の旧リフレッシュトークンは猶予内なら同じ応答を返す（計画書 第5節「トークン方針」） | integration + manual | `expires_in ≥ 86400`、`refresh_token` あり。旧トークンで 2 回目の refresh が 200 で同じ応答。24 時間以上空けた再接続は MC-5 | `apps/api/test/integration/mcp-oauth.spec.ts`、`docs/manual-tests/muse-connect.md` | green（integration）/ todo（manual） |
| R-9-3 | 契約に合わない HTML は `publish_game` が `rejected` で拒否し、`errors[].fix` に修正方法を含める。拒否では何も書かない（mc#A.6） | integration | 範囲外 duration の HTML を送り、`fix` に「180〜600」が含まれ、`posts` / `games` に行が増えない | `apps/api/test/integration/publish.spec.ts` | todo |
| R-9-4 | 新規の下書きは `trust_score` 30 未満で 5 件/日、以上で 30 件/日まで。置き換え（`post_id` 指定）は数えない（mo#A.5） | integration | 6 件目が拒否される。日付境界は手動時計。置き換えを 6 回しても通る | 同上 | todo |

## moderation A.2 / A.3 / A.4 / A.5 / A.6 / A.7 投稿状態・通報・信頼スコア・運営の操作（旧 11）

遷移と可視性の性質 M1〜M10（mo#A.10）は `verification/Moderation.tla` と、ここに並べる API の integration テストで確かめる。定数は mo#A.9 の名前で `packages/domain` に置き、テストはその値を参照する（値を変えてもテストを直さない）。

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-mo.A2-1 | 公開（`draft` / `unpublished` → `limited` / `public`）は作者の `trust_score` が `TRUST_PUBLIC_THRESHOLD` 未満なら `limited`、以上なら `public`。既存の投稿には遡らない。再公開で既に `calibrated`・制限なし・`upheld` なしなら `trust_score` によらず `public` | integration | `trust_score` 10 と 30 で公開して基本状態を見る。公開後に 30 にしても `limited` のまま。`calibrated` の投稿を `trust_score` 10 で再公開すると `public` | `apps/api/test/integration/publish.spec.ts` | todo |
| R-mo.A2-2 | `unpublish_game` は `limited` / `public` → `unpublished`。`unpublished` / `draft` は何もせず成功、`removed` は `invalid_state`、他人の投稿は `not_found`。`indiv_restricted` / `tree_locks` / `reports` は変わらない | integration | 5 つの状態と他人の投稿で呼ぶ。制限中の投稿を非公開にして再公開すると `restricted` に戻る | `apps/api/test/integration/mcp-tools.spec.ts` | todo |
| R-mo.A2-3 | `limited` は `calibration` が `calibrated` になる遷移で `public` に昇格する。`indiv_restricted` または `upheld` の通報がある投稿は昇格しない | integration | 20 件受理して `public` になる。制限中の投稿は `limited` のまま | `apps/api/test/distribution.spec.ts` | todo |
| R-mo.A2-4 | 制限は自動では解けない（M9）。`restore` / `restore_tree` 以外のどの操作・遷移でも `indiv_restricted` と `tree_locks` は減らない | integration | 再公開・昇格・`remove`・BAN の後も `indiv_restricted` が立ったまま | `apps/api/test/integration/moderation.spec.ts` | todo |
| R-mo.A3-1 | 投稿状態ごとの可視性（mo#A.3 の表）: 直リンクは `draft`（作者のみ）/ `limited` / `public` だけ 200、それ以外は `not_found` で文言は同じ。一覧には `public` だけ出る | integration | 6 状態 × 作者 / 他人でゲームページと一覧 API を呼ぶ | `apps/api/test/integration/posts.spec.ts` | todo |
| R-mo.A3-2 | `next` は発行時に `post_eligibility` を見直し、出せなくなった投稿を手番を消費せず飛ばす。発行済みの手番の結果は受理する。デイリーでも同じで、その日は 9 手番、記号列は 10 文字で飛ばした位置は skip | integration | ラン開始後に山札の 1 本を `restrict` し、`next` がそれを飛ばして `turn` が連番のまま。発行済みの手番の `result` は 200。デイリーで 1 本制限して `finish` の `symbols` が 10 文字 | `apps/api/test/runs.spec.ts` | todo |
| R-mo.A4-1 | 通報は `limited` / `public` / `restricted` の投稿にだけ付く。1 主体 1 回（2 回目は成功で何もしない）、作者自身は `invalid`、コメントは 200 文字まで | integration | 各状態と重複、作者、201 文字で呼ぶ | `apps/api/test/reports.spec.ts` | todo |
| R-mo.A4-2 | `weight` は受付時に凍結: 匿名 0、ログイン済みは `trust_score ÷ 10 × REPORT_COEF[category]`。後で通報者の `trust_score` が変わっても `reports.weight` は変わらない | integration | 新規（1.0）と 50（5.0）で `sexual` / `spam` / `broken` を通報し保存値を見る。通報後に `trust_score` を変える | 同上 | todo |
| R-mo.A4-3 | `open` の通報の重みの合計が `AUTO_RESTRICT_SUM` 以上、または `sexual` / `flashing` の合計が `AUTO_RESTRICT_SEVERE` 以上で `indiv_restricted = true` になり、`moderation_actions` に `kind = restrict`、`moderator_id = NULL` の行が入る。通報は `open` のまま、作者と通報者の `trust_score` は変わらない。匿名は何件でも制限しない（M10） | integration | 新規 10 人の `spam`、新規 2 人の `sexual`、匿名 100 人で確かめる。9 人目では制限されない。制限後も `resolution = open`、`trust_score` 不変 | 同上 | todo |
| R-mo.A5-1 | 信頼スコアの増減は mo#A.5 の 5 事象だけで、投稿ごとに各 1 回、0〜100 に切り詰める | integration | +5（日次ジョブ、7 日前に公開・通報なし）、−20（`restrict`、2 回目の `restrict` では減らない）、−50、通報者 +1 / −2、下限 0 と上限 100 | `apps/api/test/integration/moderation.spec.ts` | todo |
| R-mo.A5-2 | `post_restricted` のユーザーは `publish_game`（新規・公開）が `post_restricted` で拒否され、`unpublish_game` / `list_my_games` / 試遊は通る。`trust_score` が 0 になると自動で `post_restricted` | integration | 運営の `restrict(user_id)` 後と、`trust_score` を 0 にした後で各ツールを呼ぶ | 同上 | todo |
| R-mo.A5-3 | `ban_user` は `removed` でない全投稿を同一トランザクションで `removed` にし（`draft` は削除）、ログインを無効にする（I3、M2）。並行する `publish_game` は BAN 後に残らない | integration | 投稿 4 件（うち 1 件 `removed`、1 件 `draft`）を持つユーザーを BAN。同時に `publish_game` を走らせて、終了後に `removed` でない投稿が 0。`draft` の行は消え、`removed` に変わっていない | 同上 | todo |
| R-mo.A6-1 | `restrict_tree` は根と子孫（`parent_id` を辿る）だけを `restricted` にし、兄弟は巻き込まない。ロック中に挿入した子孫も `restricted`（M5）。`restore_tree` は `tree_locks` を消すだけで `indiv_restricted` を残す（M4）。入れ子の外側の `restore_tree` で内側は解けない | integration | 深さ 3 のツリーと兄弟で確かめる。ロック中に子を挿入、個別制限した子孫、入れ子のロック | 同上 | todo |
| R-mo.A7-1 | 運営の操作 11 行（mo#A.7。`unban_user` は列挙だけで操作は Phase 2）が `moderation_actions` に 1 行ずつ残り、通報の解決（`restrict` / `remove` / `restrict_tree` / `ban_user` → `upheld`、`restore` → `dismissed`、`restore_tree` → 変えない）と信頼スコアの変化が表のとおり | integration | 各操作の前後で `reports.resolution` と `trust_score` を見る | 同上 | todo |
| R-mo.A8-1 | `post_eligibility`: `public` × `calibrated` が `normal`、`limited` / `public` × `uncalibrated` × `thumb_key` 非 NULL が `new`、それ以外は `none`。`unpublished` → 再公開で校正状態と `post_stats` を引き継ぐ | integration | 状態の組み合わせでビューを見る。再公開後に `calibrated` のままで `normal` | `apps/api/test/integration/db.spec.ts` | todo |
| R-mo.A10-1 | M1〜M8 を `verification/Moderation.tla` で網羅検査する（2 ユーザー・投稿 3 件。`draft` / `unpublished` / 昇格 / 再公開を旧モデル C に足す） | manual | TLC が反例なしで終わる。結果は `verification/README.md` | `verification/Moderation.tla` | todo |

## data-model A.2 / A.3 / A.4 テーブルと列挙型（旧 12.1）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-12.1-1 | dm#A.3 のテーブル（`users`, `actors`, `themes`, `theme_posts`, `games`, `posts`, `sessions`, `runs`, `likes`, `reports`, `moderation_actions`, `tree_locks`, `post_stats`。Phase 2 の 3 表は任意）と dm#A.2 の列挙型 13 種（値は記載順）がマイグレーションで作られ、再適用は何もしない | integration | 空の Postgres に `migrateDb` を当て `information_schema` / `pg_enum` を見る。2 回目も成功 | `apps/api/test/integration/db.spec.ts` | red（現行は旧 12.1 の表と列挙。差分は dm#A.7） |
| R-12.1-2 | `users.handle`、`actors.device_id`、`reports(post_id, actor_id)`、`likes(post_id, actor_id)`、`sessions(run_id, turn)`、`theme_posts(theme_id, post_id)`、`post_assets(post_id, name)` は一意 | integration | 同じ値を 2 回入れて unique 違反 | 同上 | red（`actors` / `likes` / `theme_posts` が未実装） |
| R-12.1-3 | `posts.parent_id` は `posts.id` への外部キー。子がある投稿は削除できない（RESTRICT） | integration | 子を持つ親の DELETE と、存在しない親の INSERT が FK 違反 | 同上 | green |
| R-12.1-4 | `sessions.submitted_at` は `state = submitted` のときだけ非 NULL、`via` も同様（CHECK）。`score` は 0〜2^31−1、`frames` は 1〜`time_limit`、`speed` は 5 値（dm#A.3, I12） | integration | open で NULL は受理、submitted で NULL / open で非 NULL / score −1 / speed 1.1 は拒否 | 同上 | red（`via`, `frames`, `speed` が未実装） |
| R-12.1-5 | 表示用 `status` はビュー `post_status` で導出。`removed` / `unpublished` / `draft` はそのまま、`indiv_restricted` または祖先（自身含む）が `tree_locks` の根なら `restricted`、それ以外は `base_status`（dm#A.4） | integration | 深さ 3 のツリーで根をロックすると子孫も `restricted`、ロック削除で戻る。`removed` / `draft` に `indiv_restricted` を立てても変わらない | 同上 | red（`draft` / `unpublished` が未実装） |
| R-12.1-6 | `createDb` は届かない DB に対して 5 秒（既定、上書き可）で `CONNECT_TIMEOUT` を返す。postgres-js の既定 30 秒では Vercel の 10 秒制限に先に当たり原因が見えない（#40） | unit | 接続を受け付けて応答しない TCP サーバに `select 1` を投げ、`CONNECT_TIMEOUT` が 1 秒で返る。既定値 5 秒と上書きを確かめる | `apps/api/test/db-client.spec.ts` | green |

## data-model A.5 不変条件（旧 12.2）

I2・I3（ユーザー側）・I6〜I9 はアプリのトランザクションで担保するもので、DB の制約では書けない。該当する API を実装する Issue で状態を更新する。

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-12.2-1 | I1: `posts.parent_id` は挿入後に変更できない（トリガー。NULL への変更も拒否） | integration | 別の親 / NULL への UPDATE がエラー文 `parent_id` 付きで拒否。他の列の UPDATE は通る | `apps/api/test/integration/db.spec.ts` | green |
| R-12.2-2 | I2: 子の `tree_id` は親と同じ、`depth` は親 + 1。挿入時に親行を `FOR SHARE` でロックして計算する | integration | `publish_game` のトランザクションで親を同時に更新しても一貫する | `apps/api/test/integration/publish.spec.ts` | todo |
| R-12.2-3 | I3: `tree_locks.action_id` は `moderation_actions` を必ず指す（FK）。BAN されたユーザーの投稿がすべて `removed` になるのは同一トランザクションで担保（`users` を `FOR SHARE`。mo#A.5） | integration | FK: 監査行のない `tree_locks` が拒否される（green）。BAN 側は R-mo.A5-3 | 同上 / `apps/api/test/integration/moderation.spec.ts` | green（FK）/ todo（BAN） |
| R-12.2-4 | I4: `base_status` が `limited` / `public` / `unpublished` なら `published_at` は非 NULL（CHECK）。`thumb_key` は公開直後のジョブが入れる（mc#A.9）。`showcase_key` は廃止 | integration | `published_at` NULL のまま `public` にすると拒否。`thumb_key` NULL は通る。`draft` は両方 NULL 可 | `apps/api/test/integration/db.spec.ts` | red（現行は `showcase_key`） |
| R-12.2-5 | I5: `removed` から出る遷移はない。`unpublished` からは `limited` / `public` にだけ戻れる（トリガー） | integration | `removed` → `public` が拒否。`unpublished` → `public` は通り、`unpublished` → `draft` は拒否 | 同上 | red（`unpublished` が未実装、`expired` が残る） |
| R-12.2-6 | I6: `restricted` からの復帰は `moderation_actions.kind = restore / restore_tree` を伴う。自動制限の行は `moderator_id = NULL`（mo#A.4, A.7） | integration | モデレーション API が監査行と状態変更を同一トランザクションで書く。`restrict` / `restore` で `post_id` と `user_id` の両方 NULL・両方非 NULL は CHECK で拒否 | `apps/api/test/integration/moderation.spec.ts` | todo |
| R-12.2-7 | I7: 1 セッションの `submitted` 遷移は高々 1 回（`UPDATE … WHERE state = 'open'` の更新行数で判定） | integration | 同じ `session_id` への 2 回目の `PUT /sessions/{id}/result` が 409 | `apps/api/test/integration/sessions.spec.ts` | todo |
| R-12.2-8 | I8: `verdict = accepted` なら `score` が再実行結果と一致（検証ワーカーだけが `accepted` を書く。`checkpoint` は廃止）。DB ロールの分離は MVP 外 | integration | Phase 2 の検証ワーカーで。MVP では `accepted` を書く経路が検証ワーカーのみであることをコードで確認 | — | n/a（MVP） |
| R-12.2-9 | I9: 投稿の `post_assets` は合計 3 MB・32 件以下、`required` 合計 512 KB 以下（Phase 2。`asset_type` に `bgm` はない） | integration | `publish_game` のトランザクションで集計して拒否 | `apps/api/test/integration/publish.spec.ts` | n/a（Phase 2） |
| R-dm.A5-10 | I10: `game_hash` / `title` / `prompt` は `base_status = draft` の間だけ更新できる（トリガー） | integration | `draft` で更新が通り、`public` で拒否される | `apps/api/test/integration/db.spec.ts` | todo |
| R-dm.A5-11 | I11: 1 ユーザーの `draft` は 10 件以下。`updated_at` から 30 日の `draft` は日次ジョブで削除され、試遊セッションもカスケードで消える | integration | 11 件目の `publish_game` が拒否。31 日前の下書きがジョブで消え、30 日前は残る。消えた下書きの試遊セッションも消える | `apps/api/test/integration/publish.spec.ts` | todo |
| R-dm.A5-13 | I13: `ended_at` が非 NULL のランの `reached` / `avg_deviation` / `symbols` は更新できない（トリガー） | integration | finish 後の UPDATE が拒否 | `apps/api/test/integration/db.spec.ts` | todo |
| R-dm.A5-14 | I14: 主体が匿名（`actors.user_id` が NULL）の通報は受理時に `weight = 0` にする | integration | 匿名の通報が `weight = 0` で保存され、ログイン主体は信頼スコア由来の重み | `apps/api/test/reports.spec.ts` | todo |
| R-dm.A5-17 | I17: `actors.device_id` は一意。`user_id` は一度埋まったら変えられない（トリガー） | integration | 同じ `device_id` の 2 行目が拒否。`user_id` を別の値に更新すると拒否 | `apps/api/test/integration/db.spec.ts` | todo |
| R-dm.A5-15 | I15: `post_stats` には sc#A.4 の条件を満たす結果だけが入り、verdict が `rejected` / `flagged` に変わると外れ、1 主体 6 件目で最古が外れる | integration | 作者と speed 1.25 を受理しても `n` が増えない。`rejected` にすると `n` が減り `miss_below` が変わる。6 件目で `n` が増えない | `apps/api/test/distribution.spec.ts` | todo |
| R-dm.A5-16 | I16: 同じ `actor_id`・お題・日付で `recorded = true` のランは 1 本（部分一意索引） | integration | 同時に 2 本作って 1 本だけ `recorded`、2 本目は `recorded = false` で作られる | `apps/api/test/runs.spec.ts` | todo |

## data-model A.7 現行スキーマとの差分（旧 12.4。すべて追従で消える行）

| ID | 要件 | 層 | 検証方法 | テストの場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R-12.4-1 | 廃止。`games` の `verb` / `input` / `duration_frames` / `theme_id` は `meta jsonb` と `posts` に移る（dm#A.7）。`duration_frames` の範囲は静的検査（R-6.3-1） | — | — | — | n/a（追従で削除） |
| R-12.4-2 | 廃止。`runs.results[]` / `cleared` / `total` は `sessions(run_id, turn)` と凍結値に置き換える（dm#A.3, B.2） | — | — | — | n/a（追従で削除） |
| R-12.4-3 | `limited` / `public` にする投稿の `games.meta` は `verb` / `input` / `duration_frames` / `target` を持つ（トリガーまたは公開 API の検査） | integration | 欠けた `meta` のゲームを `public` にすると拒否 | 同上 | red（現行は列で検査） |
| R-12.4-4 | 廃止。ビュー `run_results` は持たない。お題の統計は `sessions` と `runs` の凍結値から出す | — | — | — | n/a（追従で削除） |
