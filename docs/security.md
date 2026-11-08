# サンドボックスとセキュリティ（security）

2026-11-08 作成。前提は `product.md` 1（ユーザー投稿のコードをブラウザで実行する）、11（変えないこと）、`game-contract.md` A.2 / A.5 / A.7、`protocol.md` A.1 / B.9、`run.md` A.13、`moderation.md` A.3。読む人は `apps/games`（配信 Worker）、`apps/web`（Host の iframe 生成）、`apps/api`（状態遷移と認証）の実装者。
節番号は `se#A.4` のように参照する。A 部が規約、B 部が理由。侵入テストの手順は `docs/manual-tests/sandbox-pentest.md`、PR ごとの再確認は `docs/security-checklist.md`。

ゲームを信用しない。防御は「別サイトの配信オリジン」「不透明オリジン（`sandbox`）」「パス指定の CSP」の 3 層で、どれか 1 層が破られてもゲームが Host のデータ・他のユーザー・他のゲームに触れないようにする。静的検査（`game-contract.md` A.11）と投稿経路の制限（`moderation.md`）は善意の作者向けで、防御線ではない。

---

# A. 規約

## A.1 用語

| 用語 | 意味 |
| --- | --- |
| アプリのオリジン | Host（SPA）、REST API、MCP サーバが同居するオリジン。`<app-origin>`（MVP は `gamefeed-seven.vercel.app`） |
| 配信オリジン | ゲーム HTML とライブラリだけを返す別サイトのオリジン。`<games-origin>`（MVP は `gamefeed-games.<account>.workers.dev`。独自ドメインは任意） |
| 不透明オリジン | `sandbox` によりオリジンが `"null"` になった文書。Cookie・ストレージ・親 DOM に触れず、どのオリジンとも同一にならない |
| Guest | 配信オリジンから読まれ、Host の iframe の中で動くゲーム（`protocol.md`） |
| 配信可否 | その `post_id` の HTML を今返してよいか。投稿状態（`moderation.md` A.3）から決まる |
| 試遊トークン | `draft` の試遊で、作者だけに配信するための短命の署名付きトークン |

## A.2 オリジンと Cookie

| オリジン | 役割 | Cookie | ストレージ |
| --- | --- | --- | --- |
| `<app-origin>` | Host、`/api/*`（REST、Better Auth、MCP）、運営画面 | Better Auth のセッション Cookie（`HttpOnly`、`Secure`、`SameSite=Lax`）。MCP は Bearer（A.8） | `device_id`（`data-model.md` A.1）を localStorage に |
| `<games-origin>/p/<post_id>/` | Guest の配信。投稿ごとに固有のパス | **一切発行しない**（`Set-Cookie` を返さない。404 も） | 使わない。ゲームからも使えない（不透明オリジン） |
| `<games-origin>/lib/<name>@<version>.min.js` | ライブラリ（`game-contract.md` A.7） | 同上 | 同上 |

- 配信オリジンは Host と別サイトに置く（`workers.dev` と `vercel.app` は別サイト）。投稿ごとの隔離はパスで分ける（B.1）
- 配信オリジンは静的ファイルしか返さず、状態を持たない（配信可否は A.5 の KV を読むだけ）
- ゲーム URL の組み立ては Host の 1 関数（`gameUrl(post_id, token?)`）に閉じる。侵入テストの結果でサブドメイン方式へ戻すときは、この関数と Worker の設定だけを変える
- アプリのオリジンはゲーム HTML を返さない。`/p/*` へのリクエストは 404

## A.3 iframe

Host は次の属性でだけ Guest を埋め込む。

```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  credentialless
  src="https://<games-origin>/p/<post_id>/">
</iframe>
```

| 属性 | 値 | 規則 |
| --- | --- | --- |
| `sandbox` | `allow-scripts` だけ | `allow-same-origin` / `allow-popups` / `allow-top-navigation` / `allow-forms` / `allow-modals` / `allow-pointer-lock` / `allow-downloads` を付けない。`allow-same-origin` がないことが最重要 |
| `allow` | 付けない | MVP の入力は tap / hold / swipe / drag / stick（`game-contract.md` A.4）で、センサーを使わない。tilt を入れるときに `accelerometer 'src'; gyroscope 'src'` を足す（B.6） |
| `referrerpolicy` | `no-referrer` | 配信オリジンに Host の URL（`run_id` を含む）を渡さない |
| `credentialless` | 付ける | 対応ブラウザでは iframe が空の Cookie ジャーで動く。未対応でも配信オリジンが Cookie を持たないので影響しない |
| `src` | A.2 の 1 関数が作る | `draft` の試遊は `?t=<試遊トークン>` を付ける（A.5）。クエリは CSP のパス照合に影響しない |

Host が描く UI（幕間・結果フラッシュ・ヘッダー・「タップしてスタート」）は iframe より上のレイヤに置き、ゲームが全画面を偽装できないようにする（`run.md` A.4）。

`sandbox` は親とトップの遷移を禁じるが、iframe 自身の遷移（`location` への代入、`<meta http-equiv="refresh">`、`<a>` のクリック）は禁じず、CSP にもこれを止める指令がない。Host は iframe の **2 回目以降の `load` イベント**（最初の読み込みの後に来るものはすべて遷移）で即座に `destroy` し、その手番を `via: error` で終える（`protocol.md` A.7、`run.md` A.6 の skip）。遷移先が外部なら 1 リクエストは出るが、Guest が持つのは自分の状態・`seed`・入力ログだけで、Host のデータは何も持っていない（A.7）。

## A.4 配信レスポンスのヘッダ

配信 Worker は `/p/<post_id>/` 配下の全レスポンス（HTML、アセット、404、405）に次を付ける。`<post_id>` だけを差し替えた同一形で、ゲーム側は `<meta http-equiv>` で緩められない（ヘッダが優先され、`sandbox` は meta で指定できない）。

```http
Content-Security-Policy:
  sandbox allow-scripts;
  default-src 'none';
  script-src 'unsafe-inline' https://<games-origin>/p/<post_id>/ https://<games-origin>/lib/;
  style-src 'unsafe-inline';
  img-src https://<games-origin>/p/<post_id>/assets/ blob:;
  media-src https://<games-origin>/p/<post_id>/assets/ blob:;
  font-src https://<games-origin>/p/<post_id>/assets/;
  connect-src https://<games-origin>/p/<post_id>/assets/ https://<games-origin>/lib/;
  worker-src 'none';
  object-src 'none';
  frame-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors https://<app-origin>;
Cross-Origin-Resource-Policy: cross-origin
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

| 規則 | 内容 |
| --- | --- |
| `sandbox allow-scripts` | ゲーム URL をトップレベルで直接開いても不透明オリジンになり、iframe の中と同じ制限で動く（`frame-ancestors` は他サイトへの埋め込みを禁じるだけで、直接開くことは防がない） |
| パス指定 | 各ソースは自投稿のパス `/p/<post_id>/` と `/lib/` だけを指す。他の投稿の `/p/<other>/` は読めない。`assets/` は Phase 2 のパスだが、ヘッダは MVP から同じ形にする |
| `connect-src` | ライブラリ（GLB ローダー等）が自投稿のアセットを `fetch` するために要る。配信側は静的ファイルしか返さないので持ち出し経路にならない |
| `worker-src 'none'` | Web Worker と Service Worker の両方を禁じる |
| CORP `cross-origin` | 不透明オリジンはどのサイトとも same-site にならないので、`same-site` だと自分のアセットを `<img>` で読めない。配信するのは公開済みの静的ファイルだけなので、他サイトから読まれても害がない（B.3） |
| リダイレクトなし | CSP のパス照合はリダイレクト後に効かない。末尾スラッシュなし等は 404。`GET` / `HEAD` 以外は 405 |
| `Cache-Control` | `draft`: `no-store`。`limited` / `public`: `public, max-age=60`（A.5 の KV の遅延に合わせる）。`/lib/`: `public, max-age=31536000, immutable` |
| `Content-Type` | HTML は `text/html; charset=utf-8`。拡張子からの推定だけで、`nosniff` を付ける |

`/lib/` 配下には `Cross-Origin-Resource-Policy: cross-origin`、`X-Content-Type-Options: nosniff`、`Cache-Control`（上記）だけを付け、CSP は付けない（スクリプトとして読まれる。トップレベルで開かれても実行されない）。

## A.5 配信可否と下書きの試遊

配信オリジンは投稿状態を持たないので、API が状態遷移のたびに KV に書き、Worker はそれを読んで配信可否を決める。

| 項目 | 規則 |
| --- | --- |
| KV のキー | `serve:<post_id>` → `{hash, status}`。`status` は `draft` / `ok` / `no` の 3 値。`hash` は R2 の `games/{hash}.html` |
| 書く側 | API。`publish_game`（下書きの作成・置き換え・公開）、`unpublish_game`、再公開、運営の操作（`restrict` / `restore` / `remove` / `restrict_tree` / `restore_tree` / `ban_user`）、自動制限、`draft` の削除。DB のトランザクションが確定した後に書き、失敗したらリトライする。ツリー制限は子孫全員分を書く |
| 対応 | 投稿状態 `limited` / `public` → `ok`。`draft` → `draft`。`restricted` / `unpublished` / `removed` と、`draft` の削除 → `no`（キーは残す） |
| Worker | `ok` なら配信。`draft` なら試遊トークンが有効なときだけ配信。`no` と未知のキーは 404。404 の文言は 3 つで同じ（存在を漏らさない） |
| 遅延 | KV は結果整合（最大 60 秒、暫定）。制限・非公開が配信に効くまで最大 60 秒 + `Cache-Control` の 60 秒を受け入れる（A.7）。日次で DB と KV を突き合わせ、ずれていれば書き直す |

下書きの試遊:

| 項目 | 規則 |
| --- | --- |
| 発行 | Host（ログイン済みの作者）が `GET /api/posts/{id}/play-token` を呼ぶ。作者本人で投稿が `draft` のときだけ返す。他は `not_found` |
| 形 | `base64url(post_id + "." + exp) + "." + base64url(HMAC-SHA256(secret, post_id + "." + exp))`。`exp` は発行から `PLAY_TOKEN_TTL = 10 分`（暫定） |
| 検証 | Worker が `GAMES_SIGNING_SECRET`（API と共有する秘密）で検証し、`post_id` が URL と一致し `exp` が未来なら配信する。トークンは `?t=` に載せる。`referrerpolicy=no-referrer` なので Guest 内からも外に漏れない |
| 使い回し | 期限内なら何度でも使える（試遊で何度もリロードする）。期限が切れたら Host が取り直す |

公開後の投稿はトークンなしで配信する。`?t=` が付いていても無視する。

## A.6 アプリのオリジンのヘッダ

| ヘッダ | 値 |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://<r2-public> data: blob:; media-src 'self' https://<r2-public> blob:; connect-src 'self'; frame-src https://<games-origin>; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Content-Type-Options` | `nosniff` |

- `frame-src` は配信オリジンだけ。Host が別の場所からゲームを読むことはない
- `<r2-public>` はサムネ・プレビュー・成績表画像の公開バケット（`data-model.md` A.6）。ゲーム HTML はここに置かない
- `/api/auth/*` と `/api/mcp` のログイン・同意画面（`status.md`）も同じヘッダ。インラインスクリプトを使わない
- COOP / COEP は付けない（B.7）

## A.7 脅威モデル

| 脅威 | 対策 | 残存 |
| --- | --- | --- |
| Host の Cookie・トークンの窃取 | 別サイト + 不透明オリジン + `HttpOnly` | なし |
| 他のユーザー・他のゲームへの干渉 | 投稿ごとのパス + CSP `sandbox` + パス指定の CSP。配信オリジンは Cookie もストレージも持たない | ブラウザのバグで `sandbox` が破られると、同じ配信オリジンの他の投稿（公開済みの静的ファイル）に触れうる。実害は小さい。必要ならサブドメイン方式へ戻す（A.2） |
| 外部へのデータ送信 | `connect-src` は自投稿パスと `/lib/` だけ。`img-src` 等も同じ。`worker-src 'none'`。`referrerpolicy=no-referrer`。静的検査が `fetch` 等と `location` への代入を拒否（補助） | DNS プリフェッチ等の副作用は `default-src 'none'` で抑止。画像に情報を描いて作者が後で見る帯域外の経路は残る（通報で対処） |
| iframe 自身の遷移（外部 URL へ `location` を書く、`meta refresh`、`<a>`） | `sandbox` と CSP では止められない。Host が 2 回目以降の `load` で即 `destroy`（A.3）。`allow-popups` / `allow-top-navigation` なしで親・トップ・別窓には行けない | 遷移先に 1 リクエストが届き、`destroy` までの数十 ms だけ外部ページが iframe に描かれる。持ち出せるのは Guest 自身の状態と `?t=`（`draft` の試遊トークン）だけ。トークンが指すのは作者自身の下書きで、それを読めるのは作者が自分で動かしたゲームだけなので、漏れても作者の意思の範囲（B.5） |
| `postMessage` の偽装 | Host は `event.source === iframe.contentWindow`、Guest は `event.source === window.parent`。内容はスキーマで検証し、違反は即破棄（`protocol.md` A.1, A.2） | なし |
| フィッシング（偽ログイン画面） | `allow-forms` なし、`form-action 'none'`、Host の UI が常に上のレイヤ（A.3） | 画面内に偽 UI を描くことはできる。通報で対処 |
| 点数の改ざん | Guest の点数は主張として扱い、サーバが 3 段階で検証する（`scoring.md` A.3）。`speed` と `seed` はサーバが発行した値を信じる | リプレイごと偽造する改ざんは検知できない。上位・外れ値だけ再実行 |
| 資源の枯渇（無限ループ、巨大 canvas） | RUNNING は常に 1 枚、監視タイマー、500 ms の long task で skip（`run.md` A.13、`protocol.md` A.7）。公開前にサーバの決定論ハーネスで 1 回実行 | iOS Safari では Guest と Host が同じプロセスで、無限ループが Host も止める（`run.md` 未解決） |
| 光過敏・音量 | 初回訪問はミュート（`run.md` A.13）、`GF.audio.gain` の上限、通報の `flashing` は係数 3（`moderation.md` A.4）。サーバ描画のフレーム列から輝度の変化を検知するのは Phase 2 | 検知前の露出 |
| 不適切な画像・文字 | 公開時の静止サムネとプレビュー動画を運営がキューで目視（`moderation.md` A.4）、通報 | canvas に描くものは投稿時に検出できない |
| クリックジャッキング | Host は `X-Frame-Options: DENY` と `frame-ancestors 'none'`（A.6） | なし |
| 制限した投稿が配信され続ける | KV の遅延 60 秒 + キャッシュ 60 秒（A.5）。`next` は発行時に DB を見て飛ばす（`moderation.md` A.3） | 直リンクで最大 2 分、制限前に読んだゲームは手番が終わるまで。受け入れる |
| 試遊トークンの漏洩 | 10 分で失効、`post_id` に紐づく、`draft` 以外には効かない | 10 分以内に作者が URL を貼れば他人が下書きを遊べる。作者の意思なので問題ない |
| MCP 経由の大量投稿 | OAuth のトークンに紐づくユーザーの `trust_score` で 5 / 30 件/日（`moderation.md` A.5）。下書きは 10 件まで（I11） | 複数アカウント。Google アカウントの作成コストに頼る |
| MCP トークンの窃取 | 作る側のアカウントで `publish_game` / `unpublish_game` / `list_my_games` ができるだけ。削除・運営の操作はツールにない（`mcp.md`） | 他人の名前でスパムを投稿される。`moderation.md` の処分で止める |

## A.8 認証と秘密情報

| 項目 | 規則 |
| --- | --- |
| 作る側のログイン | Better Auth（Google）。セッション Cookie は `HttpOnly` / `Secure` / `SameSite=Lax`。遊ぶ側はログインしない（`product.md` 3） |
| MCP | OAuth 2.1（PKCE）。DCR と CIMD の両方を受ける（`status.md`）。MCP サーバはユーザーのアクセストークンで API を呼ぶだけで、独自の権限を持たない。アクセストークンは 24 時間以上、リフレッシュトークンは 30 日、ローテーション後の旧トークンは猶予内なら同じ応答（R-9-5） |
| トークンの検証 | `requireMcpAuth` が JWKS（`/api/auth/jwks`）で検証する。トークンなしは 401 と `WWW-Authenticate`（R-9-1） |
| 運営 | `users.id` が `MODERATOR_IDS`（環境変数）に含まれるユーザーだけが運営画面と運営の操作を使える。MVP ではオーナーだけ。ロールの列は持たない |
| 秘密情報 | `DATABASE_URL`、`BETTER_AUTH_SECRET`、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`、`GAMES_SIGNING_SECRET`、`R2_*`、`CLOUDFLARE_API_TOKEN`。Vercel の環境変数と GitHub Secrets にだけ置く。リポジトリには `.env.example`（キー名だけ）。不足時は 503 `not_configured`（`status.md`） |
| 内部 API | API → Worker の KV 書き込みは Cloudflare API（`CLOUDFLARE_API_TOKEN`、KV 限定）。Worker → API の呼び出しはない |

## A.9 `/lib/` の運用

| 項目 | 規則 |
| --- | --- |
| 一覧 | `apps/games/lib/manifest.json`（`{name, version, sha256, license}` の配列）が正。静的検査（`game-contract.md` A.7）はこのファイルを読んで `@<version>` を照合する |
| 追加 | PR で `manifest.json` に行を足し、ファイルを R2 の `lib/{name}@{version}.min.js` に置く。`sha256` が一致することを CI で確かめる。ライセンスは MIT / BSD / Apache-2.0 / CC0 に限る |
| 削除 | しない。公開済みのゲームが参照している。脆弱性が出たら新しいバージョンを足し、`game-contract.md` の表（AI が読む）から古い行を外す |
| 初期一覧 | `three`、`pixi`、`matter`、`zzfx` の各 1 バージョン（`game-contract.md` A.7）。具体的なバージョンは plan#2 で固定する |

## A.10 検査する性質

`docs/manual-tests/sandbox-pentest.md`（PT-5.x）と `requirements.md`（R-5.x、R-se.x）で確かめる。

| ID | 性質 | 主な検証 |
| --- | --- | --- |
| X1 | ゲームは配信オリジンからだけ返り、アプリのオリジンでは返らない | R-5.1-1 |
| X2 | 配信オリジンは `Set-Cookie` を返さない。404 も | R-5.1-2 |
| X3 | 配信の全レスポンスに CSP `sandbox allow-scripts` が付き、直接開いても `origin === "null"` | R-5.3-1, R-5.3-3 |
| X4 | 投稿 A のゲームは投稿 B の `/p/B/` を読めず、自分の `/p/A/assets/` と `/lib/` は読める | R-5.3-2, PT-5.3-5, PT-5.3-6 |
| X5 | 配信 Worker はリダイレクトを返さない | R-5.3-4 |
| X6 | Host の iframe は A.3 の属性だけ（`allow` なし） | R-5.2-1, R-5.2-2 |
| X7 | Guest から Host の DOM・Cookie・他 iframe・外部に触れない | R-5.4-1〜4 |
| X11 | Guest が自分の iframe を遷移させたら Host が即 `destroy` し、手番は error で終わる | R-5.4-9, PT-5.4-16 |
| X8 | `limited` / `public` 以外の投稿は配信されない。`draft` は有効な試遊トークンでだけ | R-se.A5-1, R-se.A5-2 |
| X9 | 状態遷移のたびに KV が書かれ、日次の突き合わせでずれが直る | R-se.A5-3 |
| X10 | `manifest.json` にないライブラリは配信も投稿もされない | R-se.A9-1 |

---

# B. 解説（規則の理由と却下した案）

## B.1 投稿ごとのサブドメインではなくパスで分ける理由

#21。サブドメイン方式は専用ドメインの購入、ワイルドカード証明書、Public Suffix List への登録（数か月）が要り、`workers.dev` では作れない。趣味前提の MVP には重い。パス方式で失うのは、ブラウザのバグで `sandbox` が破られたときに被害が同じ配信オリジンの他の投稿に及ぶ可能性だが、配信オリジンには Cookie もストレージもなく、置いてあるのは公開済みの静的ファイルだけなので実害が小さい。Host のデータ保護は別サイトのままなので変わらない。ゲーム URL の組み立てを 1 関数に閉じ、侵入テストで通る項目が出たら設定変更で戻せるようにしておく。

## B.2 CSP ヘッダに `sandbox` を書く理由

iframe の `sandbox` 属性だけでは、ゲーム URL をトップレベルで直接開いたときに本物のオリジンで動く。旧仕様は `frame-ancestors` でこれを防げると書いていたが、`frame-ancestors` は埋め込みを禁じるだけで直接開くことは防がない（#21 の指摘）。配信 Worker が CSP ヘッダに `sandbox allow-scripts` を付ければ、どの経路で読まれても不透明オリジンになる。`<meta http-equiv>` では `sandbox` を指定できないので、ゲーム側から緩められない。

## B.3 `Cross-Origin-Resource-Policy` を `cross-origin` にする理由

旧 5.3 は `same-site` だった。不透明オリジンはどのサイトとも same-site にならないので、ゲームが自分の `/p/<id>/assets/x.png` を `<img>` で読むときにブラウザが弾く可能性がある（`status.md` 未検証）。`same-site` で守りたかったのは「他サイトが配信オリジンの資源を読む」ことだが、資源は公開済みの静的ファイルで、読まれて困るものがない。Phase 2 のアセットも同じ。`cross-origin` にして、他サイトからの読み取りは `frame-ancestors`（埋め込み）と無関係に許す。実機で `same-site` が通ることが分かっても `cross-origin` のままでよい（守るものがない）。

## B.4 配信可否を KV に持つ理由

配信 Worker は状態を持たない方が安全で速い。選択肢は (a) リクエストごとに API に問い合わせる、(b) KV に API が書く、(c) 配信可否を R2 のオブジェクトの有無で表す（制限したら消す）。(a) は Worker と API の結合と往復のレイテンシが毎回かかり、API が落ちると配信も落ちる。(c) は `games/{hash}.html` が複数の投稿で共有される（`data-model.md` B.1）ので投稿単位で消せず、制限の解除で書き戻しが要る。(b) は結果整合（最大 60 秒）を受け入れるだけで、Worker は読むだけ、API が落ちても配信は続く。制限が効くまで最大 2 分の遅れは、`next` が DB を見て飛ばすこと（`moderation.md` A.3）と合わせれば、ランには出ず直リンクだけが残る。

## B.5 下書きの試遊に署名付きトークンを使う理由

配信オリジンは Cookie を持たないので、「作者だけ」を Cookie で判定できない。選択肢は (a) 下書きをアプリのオリジンから配信する、(b) 推測できない URL（`draft` 用の乱数パス）、(c) 短命の署名付きトークン。(a) は「アプリのオリジンでゲームを実行しない」（A.2）を破る。(b) は URL がそのまま永続の鍵になり、公開後に同じパスが残ると漏洩が永続する。(c) は 10 分で失効し、`post_id` に縛られ、Worker は共有秘密だけで検証できる（API に問い合わせない）。`referrerpolicy=no-referrer` と不透明オリジンにより、`Referer` と `postMessage` からはトークンが出ない。iframe 自身の遷移（A.3）で持ち出す経路は残るが、トークンが開くのは作者自身の下書きで、その下書きを動かせるのも作者だけなので、漏洩は「作者が自分の下書きの URL を 10 分だけ人に渡した」のと同じ。

## B.6 `allow` を付けない理由

旧 5.2 は `accelerometer 'src'; gyroscope 'src'` を許していたが、tilt は保留（`product.md` 6）で MVP の入力にセンサーはない。使わない権限は与えない。tilt を入れるときに足し、R-5.2-2 と侵入テストの項目を同時に直す。

## B.7 COOP / COEP を付けない理由

`credentialless` iframe は COEP なしで使える。COEP `require-corp` をアプリのオリジンに付けると、サムネ・プレビューを置く R2 の公開バケットと Google ログインのポップアップが全部 CORP / COOP 対応を要求され、得られるのは `SharedArrayBuffer` だけで使い道がない。

---

## 未解決

- CORP `cross-origin` で不透明オリジンの `<img>` が通ることの実機確認（PT-5.3-5。`same-site` の方は確かめない）
- KV の遅延の実測。60 秒より大きければ `Cache-Control` の `max-age` と A.7 の受け入れ範囲を直す
- iOS Safari で Guest と Host が同じプロセスになる問題（`run.md` 未解決）。侵入テストと一緒に
- `/lib/` の初期バージョン（plan#2 で固定）
- 試遊トークンの TTL（10 分）。作者の試遊の往復（AI に貼って直してもらう）が 10 分を超えるなら Host が取り直すだけだが、長すぎる・短すぎるは実機で
