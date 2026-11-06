# 現在地と次の一手

新しいセッションはまずこのファイルを読む。更新は PR をマージするたび、または週次レビューで行う。

## 現在地（2026-11-06）
- **#44 で `docs/spec.md` を削除し、`docs/product.md` を正にした**（読む人ごとの文書群への分割の第 1 弾、#43）。`spec#x.y` を参照する Issue・要件 ID・計画書の記述は、その記述を正として実装してはいけない（対応表は Issue #43 のコメント）。残りの文書は `game-contract.md` → `protocol.md` → `run.md` → `scoring.md` → `data-model.md` → `security.md` → `moderation.md` → `mcp.md` の順で別 PR。検証は `verification/` に移す。大きな変更: 勝敗→点数＋順位ベースの偏差値、お題固定ラン→エンドレス主戦場（山札を周回して速度が上がる）、Showcase 廃止（サーバ描画のプレビュー）、`publish_game` は下書き→試遊→公開の 3 段、長さ 3〜10 秒。既存の静的解析（勝敗契約・180〜480 フレーム）と `games.theme_id` 等は追従が要る（追従 Issue は各文書の PR で切る）。
- 計画書 W1（11/3〜11/8）。ルール文書（#1）、スキャフォールド（#3）、CI（#11）、セッション状態機械（#6）、静的解析（#8）、メッセージスキーマ（#7、valibot）、侵入テスト手順書（#10）、DB スキーマ（#9）、MCP PoC のコード側（#5）が済み、`pnpm install && pnpm check` が緑。
- #5 で `apps/api` に Better Auth（Google）＋ `@better-auth/mcp`（OAuth 2.1 認可サーバ）＋ MCP 公式 SDK v2 の `publish_game` ダミーが入った（`src/auth.ts`・`src/mcp.ts`・`src/app.ts`・`src/pages.ts`・`src/config.ts`）。R-9-1 と R-9-5（integration）は green。**2026-11-05 に本番で MC-0〜MC-2 が通り、Muse から OAuth 2.1 / DCR で接続して `publish_game` を呼べた（R-9-2 の Muse 側 green）。計画書最大のリスクは消えたので Better Auth のまま plan#9 へ。同日に Claude のカスタムコネクタ（MC-3）と再接続（MC-4）も通り R-9-2 は green。残りは 24h 後の MC-5 だけで Issue #5 は開いたまま。** Supabase には `0002` まで当たっている（Actions `db-migrate`、Secrets `SUPABASE_DIRECT_URL`）。
  - 計画書・Issue 作成時から前提が変わった点: Better Auth の `mcp` は `@better-auth/mcp`（`@better-auth/oauth-provider` ベース、`jwt()` 必須、エンドポイントは `/api/auth/oauth2/*`）になった。MCP 仕様 2026-07-28 は DCR を非推奨にし CIMD を推奨するので、両方を有効にしている（DCR は Better Auth で明示オプトイン）。MCP SDK は v2（`@modelcontextprotocol/server` / `client`）で、`createMcpHandler` が fetch 互換なので `@hono/mcp` は使わない。
  - Better Auth のテーブルは `auth_*` と `oauth_*`（`src/db/auth-schema.ts`、マイグレーション `0002_better_auth_oauth`）。spec#12 の `users` とは `id` で結ぶ予定だが、作成フック（handle 生成）は仕様にないので plan#9 で決める。
  - 設定不足（`DATABASE_URL` / `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`）のときは `/api/health` だけ生かし、認証系は 503 `not_configured` を返す（プレビュー環境向け）。
  - ログイン・同意画面は PoC として API が `/api/connect/sign-in`・`/api/connect/consent` で最小 HTML を返す。W5 で SPA に移す。
  - `/.well-known/*` は `vercel.json` の rewrite で関数に流す。本番で効くかは MC-0 で確認する（未検証）。
  - `apps/api` の vitest は `fileParallelism: false`（db.spec と mcp-oauth.spec が同じ DB を `resetDb` するため）。
- #9 で `apps/api/src/db/schema.ts`（drizzle、spec#12.1 + 12.4）、`migrations/`（`0000_schema.sql` は生成、`0001_triggers_and_views.sql` は手書きのトリガー 3 本とビュー 2 つ）、`createDb` / `migrateDb` / `resetDb`（`src/db/client.ts`）が入った。CI は Postgres 16 の service container で `DATABASE_URL` を渡す。R-12.1-*、R-12.2-1/3/4/5、R-12.4-* が green。I2・I6・I7・I9 はアプリ側のトランザクションで担保するので API の Issue に持ち越し（対応表は `todo`）。
- スキーマ変更の手順: `schema.ts` を直す → `pnpm --filter @gamefeed/api db:generate --name <説明>` → 生成 SQL を読む → トリガー・ビューが要るなら `db:generate:custom --name <説明>` で空の SQL を作って手書き。本番（Supabase）への適用は Actions の `db-migrate` を手動実行（Secrets `SUPABASE_DIRECT_URL`、Session pooler :5432。direct 接続は IPv6 のみで Actions から届かない）。2026-11-05 に `0002` まで適用済み。
- #7 で `packages/sdk/src/messages.ts` に 10 種のスキーマと `toSessionEvent` が入った（R-6.1-5 green）。ワイヤ形式（フラット JSON）と `session_id` を載せる範囲は spec#6.1 に明記がないので #27 で提案中。承認されるまで実装はフラット前提で進めてよい。
- #10 で `docs/manual-tests/sandbox-pentest.md`（PT-5.x-n、38 項目）と R-5.1〜5.4 の要件行を追加。security-checklist.md の各行が PT / R の ID を指すようにした。
- 仕様書・計画書は #31 で repo に移した。Claude Docs 側はもう更新しない。11/3 の改訂（ミクロゲーム・MCP 一本・趣味前提、#21 の Guest 配信のパス化）のうち有効なものは新文書群に引き継ぐ（一覧は Issue #43 のコメント）。
- Vercel（本番 `gamefeed-seven.vercel.app`、hnd1）と Supabase（Tokyo）は稼働。Cloudflare は R2 バケット `gamefeed-games`（APAC）、予算アラート、GitHub Secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` まで済み。
- #4 完了。Google OAuth クライアント（テスト中、リダイレクト URI は本番 `https://gamefeed-seven.vercel.app/api/auth/callback/google` とローカル `http://localhost:3000/api/auth/callback/google`）、Vercel に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `BETTER_AUTH_URL`（Production のみ）。ドメイン購入は #21 により不要。
- #40 で `createDb` の `connect_timeout` を 5 秒にした（`DbHandle.options` で確かめられる）。DB 不達は `CONNECT_TIMEOUT` として 5 秒で返るので、Vercel の 504 と切り分けられる。
- #35 で Node.js を 26（LTS、2026-10-28〜、EOL 2029-04）に揃えた。`engines.node >=26`、CI と `db-migrate` も 26。Vercel は `engines` で決まるので新規デプロイから 26。

## 次の一手（順番どおりに）
1. **#5 の残り（オーナー）** — MC-5（2026-11-06 以降に Muse / Claude から再度ツール呼び出し、401 にならないこと）。結果を Issue #5 にコメントし、`muse-connect.md` の記録欄を埋めて #5 を閉じる。
2. **文書分割の続き（#43 の後続）**: `game-contract.md` から。各文書の PR で `requirements.md` の該当 ID を付け替え、既存実装への追従 Issue を切る。
3. **#27 のワイヤ形式**（owner 待ち）は `protocol.md` の PR に取り込む。実装はフラット前提で止めない。
4. plan#9 の本実装（W5 の前倒し）のうち、仕様が変わらない部分（OAuth、`list_my_games`、ログイン・同意画面の SPA 化）は進めてよい。`publish_game` の静的解析（勝敗→点数、3〜10 秒）・下書き→公開の遷移・`unpublish_game` の遷移先・`gf://guide` の本文は `game-contract.md` / `mcp.md` / `moderation.md` が入ってから。`users` 行の作成（handle 生成）は `data-model.md` で決める。
5. #25（静的解析の警告）は `game-contract.md` の後に。
6. W1 が終わったら plan#2（W2）: `apps/games` の CSP 実装（R-5.3-*、`sandbox-pentest.md` の integration / e2e 項目を先にテストに落とす）。

`gh issue list --milestone W1` で残りを見る。`blocked` ラベルの Issue は本文の依存先が閉じるまで触らない。

## 未検証（最初に触るときに確かめる）
- この作業環境（Claude）からの `https://gamefeed-seven.vercel.app` への fetch は Vercel に弾かれて「server error」になる。本番の状態はオーナーの curl を正とする（2026-11-05 にこれで誤診した）。
- `requireMcpAuth` は JWKS（`/api/auth/jwks`）を HTTP で取りに行く（同じ関数が自分自身を呼ぶ）。Vercel でのレイテンシと jwks キャッシュの挙動を MC-2 で見る。遅ければ `createMcpProtectedRequestHandler` に jwks をローカルで渡す形に変える。
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
- `product.md` 10 の未決 4 件。特に「匿名の遊び手にいいね・通報を許すか」は `moderation.md` の前に、「デイリーのもう一回」は `run.md` の前に要る
- `users` 行をいつ・どう作るか（Better Auth の `auth_user` 作成時に `handle` を生成するか、初回 `publish_game` 時か。`handle` の生成規則）。`data-model.md` の PR で聞く
- #27: ワイヤ形式（フラット JSON）と `session_id` を載せる Guest メッセージの範囲。`protocol.md` の PR で聞く

## AI の作業環境メモ（Claude のチャットからコンテナで作業するとき）
- `gh` は入っていない。`https://github.com/cli/cli/releases/download/v<ver>/gh_<ver>_linux_amd64.tar.gz` を curl で落として `bin/gh` を PATH に置く。認証は `GH_TOKEN` 環境変数（オーナーが PAT を貼る）。push は `gh auth setup-git` を 1 回。
- `gh issue comment` に `--jq` は無い（成功したように見えて何も書かれない）。コメントは `gh api repos/<owner>/<repo>/issues/<n>/comments --jq length` で届いたか確かめる。
- Node は 22 系が入っている（CI・本番は 26）。pnpm は `corepack enable`（`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`）。
- integration テスト用 Postgres: `apt-get install -y postgresql-16 && service postgresql start`、`postgres` ユーザーのパスワードを `postgres` に、DB `gamefeed_test` を作って `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/gamefeed_test`。コンテナが休むと落ちるので、テスト前に `service postgresql start`。
- バックグラウンドで dev サーバを動かすなら `setsid nohup ... &`。`pkill -f` は自分のシェルまで殺すので使わない。
- このコンテナから `*.vercel.app` には届かない（curl は 000、Claude の fetch ツールは Vercel に弾かれて "server error"）。本番の確認はオーナーの curl を正とする。
- ネットワークの許可先は GitHub・npm・PyPI・Ubuntu apt 程度。Supabase・Vercel・Google には届かない。
