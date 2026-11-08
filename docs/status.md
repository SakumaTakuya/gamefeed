# 現在地と次の一手

新しいセッションはまずこのファイルを読む。更新は PR をマージするたび、または週次レビューで行う。

## 現在地（2026-11-07）
- **文書分割（#43）は 9 本すべて済み**。`main` にあるのは `product.md`（未決なし）、`game-contract.md`（#48）、`protocol.md`（#51）、`run.md`（#54）、`scoring.md`（#56、`verification/scoring_check.py` 69/69）、`data-model.md`（#58）、`moderation.md`（#61。#42 の 2 を確定。`limited` は新作枠に入り校正済みで `public` に昇格、`unpublish` は可逆、自動制限の監査行は `moderator_id = NULL`。`requirements.md` に `R-mo.*` 16 行。閾値は 2026-11-08 にオーナー承認、`unban_user` を列挙に追加、`sessions.post_id` は `ON DELETE CASCADE`）、`security.md`（#63。配信可否は KV `serve:<post_id>`、`draft` の試遊は署名付きトークン、CORP は `cross-origin`、iframe の `allow` なし、`/lib/` は `manifest.json`。`requirements.md` に `R-se.*` 6 行）、`mcp.md`（#65。#42 を閉じた: `users` 行は初回ツール呼び出しで `ensureUser`、`handle` は `auth_user.name` の slug、同一内容は `reused`、R2 は SigV4 の `PutObject`。サムネは公開直後のジョブが作り I4 は `published_at` だけに、`thumb_key` が入るまで新作枠に入らない。`requirements.md` に `R-mc.*` 7 行）。旧文書は `git show d3146af^:docs/spec.md` で読める。次は `verification/`（新規。`.tla` はリポジトリに 1 つもない。次の一手 2 を見る）、`plan.md` の改訂（MVP 完了条件が勝敗前提のまま）、`requirements.md` の棚卸し（`product.md` の決定ごとに行があるか、`red` 行と追従 Issue の 1 対 1、各文書の節→行の対応表）、契約・e2e テストのハーネス Issue、`docs/manual-tests/`。
- 追従の実装 Issue: #49（静的検査）、#52（SDK スキーマと状態機械）、#59（DB スキーマ）。#25（静的解析の警告）は #49 に含めてよい。
- 文書の書き方（守る）: A 部＝規約、B 部＝理由と却下した案。理由は規則の隣に、別文書で決めた不在は書かない。決定の記録ファイルは持たない（経緯は Issue と PR 本文）。暫定値は定数として持つ。各文書末尾に「未解決」。`requirements.md` の新規行は `R-<略号>.<節>-<n>`（gc / pr / run / sc / dm / mo / se / mc）。`spec#x.y` を参照する Issue・要件 ID・計画書の記述は、その記述を正として実装してはいけない（対応表は Issue #43 のコメント）。大きな変更: 勝敗→点数＋順位ベースの偏差値、お題固定ラン→エンドレス主戦場（山札を周回して速度が上がる）、Showcase 廃止（サーバ描画のプレビュー）、`publish_game` は下書き→試遊→公開の 3 段、長さ 3〜10 秒。既存の静的解析（勝敗契約・180〜480 フレーム）と `games.theme_id` 等は追従が要る（追従 Issue は各文書の PR で切る）。
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
2. **`verification/`**（`type:spec` Issue → `spec/<n>-verification` → PR）。**注意: `Session.tla` / `Run.tla` / `Moderation.tla` はリポジトリに存在したことがない**（旧仕様 13 章が「別添」と書いていただけで、コミットされていない。`git log --all -- '*.tla'` が空）。「据え置き」ではなく新規に書く。あるのは `verification/scoring_check.py` だけ。
   - 書くもの: `Session.tla`（pr#A.12 の P1〜P4、P11〜P13。Host の状態機械 `protocol.md` A.6 / A.7 と Guest を非同期 FIFO で結ぶ。旧モデル A の骨格は `git show d3146af^:docs/spec.md` の 13.2）、`Run.tla`（run#A.15 F1〜F9。スロット N〜N+2、INITED/RUNNING、残機とミス、skip。旧モデル B は 13.3 だが 4 枚ウィンドウ前提なので作り直し）、`Lifecycle.tla`（投稿の校正状態 sc#A.7 と `limited → public` の昇格 mo#A.2。小さい）、`Moderation.tla`（mo#A.10 の M1〜M8。旧モデル C は 13.4。2 ユーザー・投稿 3 件・`draft` / `unpublished` / 昇格 / 再公開を足す）、各 `.cfg`、`README.md`（モデル → 性質 ID → 要件 ID の対応表、実行手順と結果）
   - 実行: `java` はこの作業環境にある。`tla2tools.jar` は `https://github.com/tlaplus/tlaplus/releases`（`github.com` は許可済み）から取る。`java -cp tla2tools.jar tlc2.TLC -deadlock -config Session.cfg Session.tla`。反例が出たら仕様側の誤りか モデルの誤りかを README に書く
   - 要件行: R-6.4-1（P11, P12）、R-8.2-3（F3〜F5）、R-run.A15-1（F6）、R-mo.A10-1（M1〜M8）が `verification/*.tla` を指している。PR で状態を `todo` → `green` に
   - 旧 13 章が見つけた 6 つの欠陥（13.5）は新文書に反映済みのはずなので、同じ反例が出ないことが最初の確認
3. `plan.md` の改訂（MVP 完了条件が勝敗前提のまま。`product.md` 7 と run#A.7 に合わせる）、`requirements.md` の棚卸し（`product.md` の決定ごとに行があるか、`red` 行と追従 Issue の 1 対 1、各文書の節 → 行の対応表）、契約・e2e テストのハーネス Issue。
4. 追従の実装は #49 → #52 → #59 の順。plan#9（`publish_game` 本実装）は mc#A.6 の処理順と R-mc.* をテストに落としてから（静的検査が先。SDK と DB は文書が揃ってから）。plan#9 のうち仕様が変わらない部分（OAuth、`list_my_games`、同意画面の SPA 化）は並行してよい。
5. W1 が終わったら plan#2（W2）: `apps/games` の配信実装（se#A.4 / A.5。R-5.3-*、R-se.A5-*、`sandbox-pentest.md` の integration / e2e 項目を先にテストに落とす。KV の namespace と `GAMES_SIGNING_SECRET` はオーナー作業）。

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
- se#A.4 の `Cross-Origin-Resource-Policy: cross-origin` で不透明オリジンの `<img>` が通ること（PT-5.3-5）は実ブラウザ未確認。KV の遅延（se#A.5 の 60 秒）も未実測。
- `apps/games/src/index.ts` の `CSP` 定数は仮のもの。plan#2 で se#A.4 のヘッダ（`sandbox` ＋ パス指定）に置き換え、R-5.3-* のテストを先に書く。
- Biome の `recommended` で info が 1 件出る。実害なし。
- `sandbox-pentest.md` の攻撃 HTML はまだ実ブラウザで 1 度も走らせていない（Worker も Host もない）。plan#2 で `fixtures/games/pentest/index.html` に落として最初に走らせる。
- SDK のバンドルは esbuild の実測（valibot 込みで 2.4 KB gz）のみ。SDK 本体のビルドを作るときに再計測する。

## オーナーに聞かないと決められないこと
- iOS Safari で Guest の無限ループが Host を止める問題の実機確認（run#未解決）。侵入テストと一緒に

## AI の作業環境メモ（Claude のチャットからコンテナで作業するとき）
- `gh` は入っていない。`https://github.com/cli/cli/releases/download/v<ver>/gh_<ver>_linux_amd64.tar.gz` を curl で落として `bin/gh` を PATH に置く。認証は `GH_TOKEN` 環境変数（オーナーが PAT を貼る）。push は clone の URL に `x-access-token:$GH_TOKEN@` を含める（`gh auth setup-git` でもよい）。
- `gh pr create` / `gh pr edit` / `gh issue view` / `gh issue create` はこのリポジトリで Projects (classic) の非推奨エラーを出して失敗する。Issue の作成も `gh api -X POST repos/<o>/<r>/issues --input -`、閲覧は `gh api repos/<o>/<r>/issues/<n>`。`gh api -X POST repos/<o>/<r>/pulls --input -` と `-X PATCH repos/<o>/<r>/pulls/<n>` を使う。ラベルは `issues/<n>/labels`、マイルストーンは `issues/<n>` の PATCH（W2 は `milestone: 2`）。レビューコメントへの返信は `pulls/<n>/comments/<id>/replies`。`gh pr merge --squash --delete-branch` は使える（オーナーの LGTM の後）。
- Codex（`chatgpt-codex-connector[bot]`）が PR をレビューする。指摘は `pulls/<n>/comments` で読み、直して返信する。P1 は設計に関わることが多い。
- **ブランチは必ず `origin/main` から切る**（マージ済みのローカルブランチから切ると squash との差で conflict する）。スクリプトで文書を編集したら、コミット前に `wc -l` と `grep -c '^## '` で行数と見出し数を確かめる（空文字列の `replace` で全文が複製された事故が 1 度ある）。
- `gh issue comment` に `--jq` は無い（成功したように見えて何も書かれない）。コメントは `gh api repos/<owner>/<repo>/issues/<n>/comments --jq length` で届いたか確かめる。
- Node は 22 系が入っている（CI・本番は 26）。pnpm は `corepack enable`（`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`）。
- integration テスト用 Postgres: `apt-get install -y postgresql-16 && service postgresql start`、`postgres` ユーザーのパスワードを `postgres` に、DB `gamefeed_test` を作って `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/gamefeed_test`。コンテナが休むと落ちるので、テスト前に `service postgresql start`。
- バックグラウンドで dev サーバを動かすなら `setsid nohup ... &`。`pkill -f` は自分のシェルまで殺すので使わない。
- このコンテナから `*.vercel.app` には届かない（curl は 000、Claude の fetch ツールは Vercel に弾かれて "server error"）。本番の確認はオーナーの curl を正とする。
- ネットワークの許可先は GitHub・npm・PyPI・Ubuntu apt 程度。Supabase・Vercel・Google には届かない。
