# 現在地と次の一手

新しいセッションはまずこのファイルを読む。更新は PR をマージするたび、または週次レビューで行う。

## 現在地（2026-11-04）
- 計画書 W1（11/3〜11/8）。ルール文書（#1）、スキャフォールド（#3）、CI（#11）、セッション状態機械（#6）、静的解析（#8）、メッセージスキーマ（#7、valibot）、侵入テスト手順書（#10）、DB スキーマ（#9）、MCP PoC のコード側（#5）が済み、`pnpm install && pnpm check` が緑。
- #5 で `apps/api` に Better Auth（Google）＋ `@better-auth/mcp`（OAuth 2.1 認可サーバ）＋ MCP 公式 SDK v2 の `publish_game` ダミーが入った（`src/auth.ts`・`src/mcp.ts`・`src/app.ts`・`src/pages.ts`・`src/config.ts`）。R-9-1 と R-9-5（integration）は green。**Muse / Claude の実機確認（R-9-2、`docs/manual-tests/muse-connect.md` MC-0〜MC-5）はオーナー待ちで Issue #5 は開いたまま。**
  - 計画書・Issue 作成時から前提が変わった点: Better Auth の `mcp` は `@better-auth/mcp`（`@better-auth/oauth-provider` ベース、`jwt()` 必須、エンドポイントは `/api/auth/oauth2/*`）になった。MCP 仕様 2026-07-28 は DCR を非推奨にし CIMD を推奨するので、両方を有効にしている（DCR は Better Auth で明示オプトイン）。MCP SDK は v2（`@modelcontextprotocol/server` / `client`）で、`createMcpHandler` が fetch 互換なので `@hono/mcp` は使わない。
  - Better Auth のテーブルは `auth_*` と `oauth_*`（`src/db/auth-schema.ts`、マイグレーション `0002_better_auth_oauth`）。spec#12 の `users` とは `id` で結ぶ予定だが、作成フック（handle 生成）は仕様にないので plan#9 で決める。
  - 設定不足（`DATABASE_URL` / `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`）のときは `/api/health` だけ生かし、認証系は 503 `not_configured` を返す（プレビュー環境向け）。
  - ログイン・同意画面は PoC として API が `/api/connect/sign-in`・`/api/connect/consent` で最小 HTML を返す。W5 で SPA に移す。
  - `/.well-known/*` は `vercel.json` の rewrite で関数に流す。本番で効くかは MC-0 で確認する（未検証）。
  - `apps/api` の vitest は `fileParallelism: false`（db.spec と mcp-oauth.spec が同じ DB を `resetDb` するため）。
- #9 で `apps/api/src/db/schema.ts`（drizzle、spec#12.1 + 12.4）、`migrations/`（`0000_schema.sql` は生成、`0001_triggers_and_views.sql` は手書きのトリガー 3 本とビュー 2 つ）、`createDb` / `migrateDb` / `resetDb`（`src/db/client.ts`）が入った。CI は Postgres 16 の service container で `DATABASE_URL` を渡す。R-12.1-*、R-12.2-1/3/4/5、R-12.4-* が green。I2・I6・I7・I9 はアプリ側のトランザクションで担保するので API の Issue に持ち越し（対応表は `todo`）。
- スキーマ変更の手順: `schema.ts` を直す → `pnpm --filter @gamefeed/api db:generate --name <説明>` → 生成 SQL を読む → トリガー・ビューが要るなら `db:generate:custom --name <説明>` で空の SQL を作って手書き。本番（Supabase）への適用は `DATABASE_URL=... pnpm --filter @gamefeed/api db:migrate`（まだ 1 度も当てていない）。
- #7 で `packages/sdk/src/messages.ts` に 10 種のスキーマと `toSessionEvent` が入った（R-6.1-5 green）。ワイヤ形式（フラット JSON）と `session_id` を載せる範囲は spec#6.1 に明記がないので #27 で提案中。承認されるまで実装はフラット前提で進めてよい。
- #10 で `docs/manual-tests/sandbox-pentest.md`（PT-5.x-n、38 項目）と R-5.1〜5.4 の要件行を追加。security-checklist.md の各行が PT / R の ID を指すようにした。
- 仕様書・計画書は #31 で repo に移した（`docs/spec.md` / `docs/plan.md`）。Claude Docs 側はもう更新しない。11/3 にミクロゲーム・MCP 一本・趣味前提で改訂済み。同日、#21 で Guest 配信を「投稿ごとのサブドメイン」から「配信オリジン上のパス `/p/<post_id>/` ＋ CSP `sandbox allow-scripts`」に変更（仕様書 rev 38）。
- Vercel（本番 `gamefeed-seven.vercel.app`、hnd1）と Supabase（Tokyo）は稼働。Cloudflare は R2 バケット `gamefeed-games`（APAC）、予算アラート、GitHub Secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` まで済み。
- #4 完了。Google OAuth クライアント（テスト中、リダイレクト URI は本番 `https://gamefeed-seven.vercel.app/api/auth/callback/google` とローカル `http://localhost:3000/api/auth/callback/google`）、Vercel に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `BETTER_AUTH_URL`（Production のみ）。ドメイン購入は #21 により不要。

## 次の一手（順番どおりに）
1. **#5 の実機確認（オーナー）** — (a) Supabase に `0002_better_auth_oauth` を当てる（`DATABASE_URL=<direct :5432> pnpm --filter @gamefeed/api db:migrate`、または Secrets `SUPABASE_DIRECT_URL` を入れて Actions の `db-migrate` を手動実行。pooler は Transaction mode なので direct 接続で当てる）。(b) `docs/manual-tests/muse-connect.md` の MC-0〜MC-3 を本番で実施し、結果を Issue #5 にコメント（Google ログインはプレビュー環境では使えない）。通れば #5 を閉じて plan#9 は W5 へ。だめなら Cloudflare `workers-oauth-provider` 切替の Issue を切る。(c) MC-5 は翌日以降。
2. **#26 spec 第4.1章の切れた行**（owner 待ち）と **#27 spec#6.1 のワイヤ形式**（owner 待ち）はオーナーの返事を待つ。実装は止めない。
3. W1 が終わったら plan#2（W2）: `apps/games` の CSP 実装（R-5.3-*、`sandbox-pentest.md` の integration / e2e 項目を先にテストに落とす）。

`gh issue list --milestone W1` で残りを見る。`blocked` ラベルの Issue は本文の依存先が閉じるまで触らない。

## 未検証（最初に触るときに確かめる）
- Supabase 本番にマイグレーションを当てていない。`db:migrate` の初回で `drizzle` スキーマが作れること（権限）を確かめる。
- Vercel で `/.well-known/(.*)` → `/api` の rewrite が関数に元のパスを渡すこと（MC-0 の curl）。だめなら Better Auth の `oauthProviderAuthServerMetadata(auth)` 等を別の関数（`api/well-known.js`）として置く。
- `requireMcpAuth` は JWKS（`/api/auth/jwks`）を HTTP で取りに行く（同じ関数が自分自身を呼ぶ）。Vercel でのレイテンシと jwks キャッシュの挙動を MC-2 で見る。遅ければ `createMcpProtectedRequestHandler` に jwks をローカルで渡す形に変える。
- Muse が DCR で送ってくる `redirect_uris` / `application_type` が Better Auth の検証（native / web の判定）を通るか。通らなければ `validateRedirectUri` で緩める（MC-1）。
- Muse / Claude が 2025 世代（セッション型 Streamable HTTP）と 2026-07-28 のどちらで話すか。サーバは `legacy: "stateless"`（既定）で両方受けるが、GET（SSE 再開）は 405 にしている。
- `post_status` ビューは再帰 CTE を全投稿に対して回す。投稿が数千件になったら `EXPLAIN` を見て、`tree_locks` が空のときに短絡するか、`tree_id` 単位に絞る。
- ローカルで DB テストを回す手順: Postgres 16 を立てて `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/gamefeed_test pnpm --filter @gamefeed/api test`。`resetDb` が `public` / `drizzle` スキーマを落とすので専用 DB を使う。
- Google OAuth は「テスト中」のため、テストユーザーに登録したアカウントしかログインできない。友達を招く前にオーナーが「本番環境へ公開」するか、テストユーザーに追加する。
- `apps/games` は `wrangler` を入れていない（依存が重いため）。plan#2 で着手するときに `wrangler` と Miniflare を devDependencies に追加する。
- GitHub Secrets（Cloudflare）は作業用 PAT に読む権限がなく存在を確認できていない。plan#2 の初回 CI デプロイで確かめる。
- spec#5.3 の `Cross-Origin-Resource-Policy: same-site` は、sandbox（不透明オリジン）のゲームが自分のアセットを `<img>` 等で読むときに弾かれる可能性がある（不透明オリジンはどのサイトとも same-site にならない）。plan#2 の e2e（R-5.3-2）で実ブラウザで確かめ、弾かれるなら `cross-origin` に変える仕様変更 Issue を切る。
- `apps/games/src/index.ts` の `CSP` 定数は仮のもの。plan#2 で spec#5.3 のヘッダ（`sandbox` ＋ パス指定）に置き換え、R-5.3-* のテストを先に書く。
- Biome の `recommended` で info が 1 件出る。実害なし。
- `sandbox-pentest.md` の攻撃 HTML はまだ実ブラウザで 1 度も走らせていない（Worker も Host もない）。plan#2 で `fixtures/games/pentest/index.html` に落として最初に走らせる。
- SDK のバンドルは esbuild の実測（valibot 込みで 2.4 KB gz）のみ。SDK 本体のビルドを作るときに再計測する。

## オーナーに聞かないと決められないこと
- #26: spec#4.1「メタデータ」行の切れ（`gf:controls` と `gf:input` の不一致）
- #27: spec#6.1 のワイヤ形式（フラット JSON）と `session_id` を載せる Guest メッセージの範囲
