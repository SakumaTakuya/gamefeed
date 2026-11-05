# Muse / Claude のカスタムコネクタから MCP に接続する（#5 PoC）

計画書 第5節「ログインと認可サーバ」と第6節「Muse から OAuth/DCR で繋がらない」の判断材料。`docs/requirements.md` の R-9-2・R-9-5（manual 側）に対応する。
項目 ID は `MC-<連番>`。integration で確かめたこと（R-9-1、R-9-5 の integration 側）はここでは繰り返さない。

## 前提

- `main` がマージされて Vercel 本番（`https://gamefeed-seven.vercel.app`）にデプロイ済み。
- Supabase 本番にマイグレーション `0002_better_auth_oauth` が当たっている（`DATABASE_URL=<direct :5432 の URL> pnpm --filter @gamefeed/api db:migrate`、または GitHub Actions の `db-migrate` を手動実行）。
- Vercel の Production に `DATABASE_URL`・`BETTER_AUTH_SECRET`・`BETTER_AUTH_URL=https://gamefeed-seven.vercel.app`・`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` が入っている（#4）。
- Google OAuth クライアントは「テスト中」なので、テストユーザーに登録した Google アカウントでログインする。
- プレビュー環境では Google ログインが使えない（URL が毎回変わる）。**本番でのみ**実施する。

### 端末

| 端末 | OS | クライアント |
| --- | --- | --- |
| iPhone | iOS 最新 | Muse（カスタムコネクタ） |
| Mac または iPhone | — | Claude（claude.ai の「カスタムコネクタ」または Claude アプリ） |

### エンドポイント

| 用途 | URL |
| --- | --- |
| MCP サーバ（コネクタに登録する URL） | `https://gamefeed-seven.vercel.app/api/mcp` |
| 認可サーバメタデータ（RFC 8414） | `https://gamefeed-seven.vercel.app/.well-known/oauth-authorization-server/api/auth` |
| 保護リソースメタデータ（RFC 9728） | `https://gamefeed-seven.vercel.app/.well-known/oauth-protected-resource/api/mcp` |
| ログイン画面（認可フロー中に自動で飛ぶ） | `https://gamefeed-seven.vercel.app/api/connect/sign-in` |

## 手順

### MC-0 デプロイ直後の疎通（curl、オーナーの Mac）

```sh
curl -s https://gamefeed-seven.vercel.app/.well-known/oauth-authorization-server/api/auth | jq '{issuer, registration_endpoint, code_challenge_methods_supported}'
curl -s https://gamefeed-seven.vercel.app/.well-known/oauth-protected-resource/api/mcp | jq '{resource, authorization_servers}'
curl -si -X POST https://gamefeed-seven.vercel.app/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -5
```

期待:
- 1 つ目: `issuer` が `https://gamefeed-seven.vercel.app/api/auth`、`registration_endpoint` が `…/api/auth/oauth2/register`、`code_challenge_methods_supported` が `["S256"]`。
- 2 つ目: `resource` が `https://gamefeed-seven.vercel.app/api/mcp`、`authorization_servers` が issuer の配列。
- 3 つ目: `HTTP/2 401` と `www-authenticate: Bearer … resource_metadata="https://gamefeed-seven.vercel.app/.well-known/oauth-protected-resource/api/mcp"`。
- どれかが `index.html`（SPA）を返したら `vercel.json` の `/.well-known/(.*)` rewrite が効いていない。503 `not_configured` なら Vercel の環境変数不足（`missing` に名前が出る）。

### MC-1 Muse にコネクタを登録する

1. Muse の設定からカスタムコネクタを追加し、URL に `https://gamefeed-seven.vercel.app/api/mcp` を入れる。
2. 接続ボタンを押す。ブラウザ（またはアプリ内ブラウザ）で GameFeed のログイン画面が開く。
3. 「Google でログイン」→ テストユーザーの Google アカウントでログイン。
4. 同意画面（クライアント ID とスコープ `openid profile email offline_access` が表示される）で「許可する」。
5. Muse に戻り、コネクタが「接続済み」になる。

期待: コネクタ一覧に登録され、ツール `publish_game` が見える。
失敗の見分け方:
- 登録画面でエラーになり、ログイン画面すら開かない → DCR か `.well-known` の問題。Vercel のログで `POST /api/auth/oauth2/register` の応答を見る（`invalid_client_metadata` なら Muse が送る `redirect_uris` / `application_type` を Issue に貼る）。
- Google から戻った後に同意画面に進まない → `sign-in/social` に `oauth_query` が渡っていない。`/api/connect/sign-in` の URL に `sig=` が付いているか確認する。
- 同意後にクライアントへ戻らない → `redirect_uri` の検証失敗。Vercel のログで `invalid_redirect_uri` を探す。

### MC-2 Muse からダミー投稿が通る

Muse に次を貼る。

```text
GameFeed の publish_game を呼んで。title は「接続テスト」、prompt は「PoC」、html は <!doctype html><title>t</title> で。
```

期待: ツール呼び出しが成功し、応答に `post_id`（`gf:poc-` で始まる）、`url`、`warnings`（「ダミー」の注意）、`user_id`（ログインしたユーザーの ID）が入る。401 や「再認証してください」が出ない。

### MC-3 Claude のカスタムコネクタで MC-1・MC-2 と同じ

claude.ai → 設定 → コネクタ → カスタムコネクタを追加 → URL `https://gamefeed-seven.vercel.app/api/mcp`。以降は MC-1・MC-2 と同じ。
Claude は DCR で登録し、`urn:ietf:params:oauth:grant-type:jwt-bearer` も `grant_types` に入れてくるが、サーバは `authorization_code` と `refresh_token` だけを登録する（Better Auth の仕様）。これで失敗しないことを確認する。

### MC-4 二度目以降は同意画面が出ない

コネクタを一度切断して再接続する。期待: ログインは求められても（セッションが切れていれば）、同意画面はスキップされてすぐ戻る。

### MC-5 24 時間以上空けてから再度ツールを呼ぶ（R-9-5 manual）

MC-2 の翌日以降に、同じ Muse / Claude から `publish_game` をもう一度呼ぶ。
期待: 401 にならず、再認証なしで通る（アクセストークン 24h + リフレッシュトークン 30 日）。
「再認証してください」が出たら、Vercel のログで `POST /api/auth/oauth2/token` の `grant_type=refresh_token` の応答（`invalid_grant` か）を Issue #5 に貼る。

## 判断

- MC-1〜MC-3 が通る → Better Auth のまま plan#9（W5）に進む。
- MC-1 で Muse がコネクタとして登録されない、または MC-2 が通らない → 計画書 第6節のとおり Cloudflare `workers-oauth-provider` への切替（＋1 人日）を提案する Issue を切る。Claude 側だけ通るなら「Claude コネクタ＋貼り付けフォームで MVP」。

## 記録

| 日付 | 項目 | 端末 / クライアント | 結果 | 所見 |
| --- | --- | --- | --- | --- |
| 2026-11-05 | MC-0 | Mac / curl | pass | issuer・registration_endpoint・S256、resource・authorization_servers、401 + `www-authenticate: Bearer resource_metadata=…` すべて期待どおり。`/.well-known/(.*)` の rewrite は関数に元のパスを渡す |
| 2026-11-05 | MC-1 | iPhone / Muse | pass | コネクタ登録 → Google ログイン → 同意 → 接続済み。DCR の登録メタデータは Better Auth の検証を通った |
| 2026-11-05 | MC-2 | iPhone / Muse | pass | `publish_game` が通り `post_id: gf:poc-mw3b9vk5`、url、echo（title「接続テスト」、html 31 バイト、prompt 3 文字）、ダミー警告が返った |
| | MC-3 | / Claude | | |
| | MC-4 | | | |
| | MC-5 | | 2026-11-06 以降 | |

判断（2026-11-05）: MC-1・MC-2 が通ったので Better Auth のまま plan#9（W5）へ。Cloudflare `workers-oauth-provider` への切替は不要。
