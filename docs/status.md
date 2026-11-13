# 現在地と次の一手

新しいセッションはまずこのファイルを読む。更新は PR をマージするたび、または週次レビューで行う。

## 現在地（2026-11-13）
- **plan#9（MCP サーバ本実装）に着手**。Issue は 4 本: #86 `ensureUser` と `handle`（済み、#90）、#87 `publish_game` 本実装（済み。`apps/api/src/publish.ts` の `publishGame` が mc#A.6 の 1〜12 を行い、`mcp.ts` はツールの形と説明文だけ。R2 / KV は `GameStorage` / `ServeKv` のインターフェースで、テストはメモリの fake。`users` ごとに `pg_advisory_xact_lock` で直列化。ULID は `src/id.ts`）、#88 `list_my_games` / `unpublish_game` / `gf://guide`（済み。`src/my-games.ts`。`gf://guide` の本文は `pnpm --filter @gamefeed/api gen:guide` が `docs/game-contract.md` の A 部を `src/guide.gen.ts` に取り込み、`test/guide.spec.ts` がずれを検出する。**game-contract.md の A 部を直したら gen:guide を実行してコミットする**。`list_my_games` の `structuredContent` は `{games: [...]}`、`restricted_reason` は `dismissed` 以外の通報をカテゴリごとに数える）、#89 R2 の SigV4 `PutObject` と KV の実体（済み。`src/r2.ts` の `signV4` は AWS の公開テストベクタ 2 本と一致、`src/kv.ts` は Cloudflare API。`config.ts` が `R2_*` 4 つと `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `KV_NAMESPACE_ID` を読み、揃わなければ `storage` / `kv` を渡さない。KV は `syncServe(db, kv, post_id)` だけが書く: 投稿ごとの advisory lock の中で `game_hash`・`stored_at`・状態を 1 文で読み直し、R2 に無い内容（`stored_at` NULL）は `no` 以外書かない。R2 / KV に書けなければ `storage_failed`、`unpublish_game` も同じ。下書きへの `unpublish_game` は KV を触らない）。**2026-11-12 に本番で動いた**: オーナーが Vercel の Production に 7 変数を入れ、Muse から `publish_game` で下書き（`01M782MV00TMYMTHTGG5C6KS3T`、`gf://guide` の最小例）を投稿。R2 の `games/<hash>.html` と KV の `serve:<post_id>` ができたことをダッシュボードで確認した（R-mc.A8-1 manual はキーの存在まで。KV の値 `{hash, status}` が R2 のキーのハッシュと `draft` に一致するかの照合が残り。オーナーがダッシュボードで値を見る）。変数が欠ければ今も `not_configured`（文面に足りない変数名が出る）。試遊 URL（`/draft/<id>`）は SPA 側が、配信は `apps/games` が未実装なので、まだ遊べない。仕様に明記がなく仮置きした 7 点（#91）は 2026-11-11 にオーナーが仮案のまま承認。文書への反映は PR #93（マージ済み）。**#97（`type:spec`、オーナーの判断待ち）**: `post_id` つきで公開した呼び出しが R2 / KV で失敗すると、同じ入力の呼び直しが `invalid_state` になる（`post_id` を外せば A.7 で戻れる）。`banned` を HTTP の 401 にする部分（mc#A.2）は未実装で、moderation の実装（R-mo.A5-3）と一緒に入れる
- 本番 DB（Supabase）は 2026-11-11 にオーナーが `db-migrate` を実行し成功（Actions の記録）。`0006` まで当たっている前提で進める
- **文書分割（#43）は 9 本すべて済み**。`main` にあるのは `product.md`（未決なし）、`game-contract.md`（#48）、`protocol.md`（#51）、`run.md`（#54）、`scoring.md`（#56、`verification/scoring_check.py` 69/69）、`data-model.md`（#58）、`moderation.md`（#61。#42 の 2 を確定。`limited` は新作枠に入り校正済みで `public` に昇格、`unpublish` は可逆、自動制限の監査行は `moderator_id = NULL`。`requirements.md` に `R-mo.*` 16 行。閾値は 2026-11-08 にオーナー承認、`unban_user` を列挙に追加、`sessions.post_id` は `ON DELETE CASCADE`）、`security.md`（#63。配信可否は KV `serve:<post_id>`、`draft` の試遊は署名付きトークン、CORP は `cross-origin`、iframe の `allow` なし、`/lib/` は `manifest.json`。`requirements.md` に `R-se.*` 6 行）、`mcp.md`（#65。#42 を閉じた: `users` 行は初回ツール呼び出しで `ensureUser`、`handle` は `auth_user.name` の slug、同一内容は `reused`、R2 は SigV4 の `PutObject`。サムネは公開直後のジョブが作り I4 は `published_at` だけに、`thumb_key` が入るまで新作枠に入らない。`requirements.md` に `R-mc.*` 7 行）。旧文書は `git show d3146af^:docs/spec.md` で読める。`verification/` は #68 で 4 モデル（`Session` / `Run` / `Lifecycle` / `Moderation`）を新規に書き（#69）、見つけた仕様の穴 4 件はオーナー承認のうえ文書に反映済み: skip 後のスロット補充と F3 の言い換え（#72 → #75）、`restore` / `restore_tree` が `limited ∧ calibrated ∧ upheld なし` を昇格（#70 → #71、mo#B.9）、BAN で `draft` は削除（#73 → #76）、`finish` で未提出の手番は最後の結果より後なら数えず前なら `miss_below` ありはミス・なしは skip、Host は最後の `result` の応答を待って `finish`（#74 → #77、run#B.2）。モデルも追従済み（#78 → #79）。結果は `verification/README.md`。残りは `Moderation.cfg`（2 ユーザー・投稿 3 件）と `Moderation_1u3p.cfg` の完走（1 CPU / 3 GB では止まる。別環境か `open` を 2 値にする削減）。次は `plan.md` の改訂（MVP 完了条件が勝敗前提のまま）、`requirements.md` の棚卸し（`product.md` の決定ごとに行があるか、`red` 行と追従 Issue の 1 対 1、各文書の節→行の対応表）、契約・e2e テストのハーネス Issue、`docs/manual-tests/`。
- **追従の実装は 3 本とも済み**: #49（静的検査、#81）、#52（SDK スキーマと状態機械、#82: 9 種・`sdk 2.0`・`end{score, frames}`・`init.speed` 5 値・`log.inputs` は kind ごとの `strictTuple`、domain は `SessionResult = {score, frames?, via, scoreable, flagged}`・`watchdogMs(timeLimit, speed)`・`log` の順序検査で `flagged`）、#59（DB スキーマ、#83: マイグレーション `0004`〜`0006`。`0004` が旧表を TRUNCATE、`0006` にトリガー 8 本とビュー `post_status` / `post_eligibility`）。#25 は #49 で済んだので閉じた。`requirements.md` の R-6.1-* / R-6.4-* / R-pr.* / R-12.* / R-dm.A5-10,13,14,16,17 は green。本番への適用は 2026-11-11 に済み（上）
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
2. `verification/Moderation.cfg` と `Moderation_1u3p.cfg` の完走（別環境。急がない）。完走したら `README.md` の表と R-mo.A10-1 を更新
3. `plan.md` の改訂（MVP 完了条件が勝敗前提のまま。`product.md` 7 と run#A.7 に合わせる）、`requirements.md` の棚卸し（`product.md` の決定ごとに行があるか、`red` 行と追従 Issue の 1 対 1、各文書の節 → 行の対応表）、契約・e2e テストのハーネス Issue。
4. **オーナー作業**: (a) #97 の案を選ぶ (b) PR #99（Codex レビューの扱い。`docs/workflow.md`「Codex レビュー」）のレビューとマージ。plan#9 の残りは `banned` の 401（mc#A.2。moderation の実装と一緒に）。同意画面の SPA 化、試遊ページ（`/draft/<id>`）、SDK ランタイム本体（`GF`、壁時計 `end`、`stick`）、契約テストのハーネスは別 Issue を切る。Muse 側のツール許可リストに `list_my_games` / `unpublish_game` はまだ入っていない（Muse の設定。必要になったらオーナーが足す）。
5. W1 が終わったら plan#2（W2）: `apps/games` の配信実装（se#A.4 / A.5。R-5.3-*、R-se.A5-*、`sandbox-pentest.md` の integration / e2e 項目を先にテストに落とす。KV の namespace は #89 で作ったもの（`KV_NAMESPACE_ID` と同じ）を `wrangler.toml` にバインドする。`GAMES_SIGNING_SECRET` はオーナー作業）。

`gh issue list --milestone W1` で残りを見る。`blocked` ラベルの Issue は本文の依存先が閉じるまで触らない。

## Cloudflare の設定メモ（2026-11-12）
- R2 の API トークンは作成後の画面に「トークンの値」と「S3 クライアント」用のキーが出る。使うのは後者（アクセスキー ID とシークレット）。シークレットはその画面でしか見られない。
- KV 用の API トークンは Account API トークン（Manage Account → API Tokens）。作成画面は「権限ポリシー」形式で、「最初から作成」→ アカウント全体 → `Workers KV Storage: Write` だけ。GitHub Secrets の `CLOUDFLARE_API_TOKEN`（CI 用）とは別物。
- KV の namespace は管轄（eu / us / fedramp）なし・従来型（Instant ではない）。管轄は作成後に変えられない。
- Vercel で Sensitive にしたのは `R2_SECRET_ACCESS_KEY` と `CLOUDFLARE_API_TOKEN`（`R2_ACCESS_KEY_ID` は任意）。ID と URL は打ち間違いを確かめられるよう普通の変数。

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
- TLC（`verification/`）は `tla2tools.jar` を GitHub releases から取る。Moderation の 2u2p は 4 分・270 万状態、1u3p はそれ以上かかる。`-metadir /tmp/tlcstates` で `states/` を外に出し、長いものは `setsid nohup` で回す。`pkill -f` も `kill $(pgrep -f 'java -XX')` も、そのパターンを含む自分のシェルを殺す。kill はパターンを含まないスクリプトファイルから実行するか、`pgrep -a java | grep tlc2` で PID を見て直接 `kill <pid>`
- コミット前に `git config user.name motaku` / `user.email mo.takusakkun@gmail.com`（コンテナには identity が無く、`git commit` が失敗して `&&` で繋いだ後続が黙って飛ぶ）。
- MCP のツール層のテストは `InMemoryTransport.createLinkedPair()` で `createMcpServer` に直接繋ぐ（`mcp-tools.spec.ts`）。OAuth を通すのは `mcp-oauth.spec.ts` の 1 本だけでよい。`publishGame` は自分でコミットするので、テストは `truncate table posts, games, users, auth_user cascade` で毎回空にする
- `gh` は入っていない。`https://github.com/cli/cli/releases/download/v<ver>/gh_<ver>_linux_amd64.tar.gz` を curl で落として `bin/gh` を PATH に置く。認証は `GH_TOKEN` 環境変数（オーナーが PAT を貼る）。push は clone の URL に `x-access-token:$GH_TOKEN@` を含める（`gh auth setup-git` でもよい）。
- マージは `gh api -X PUT pulls/<n>/merge` の返り値 `merged` を見てからブランチを消す（失敗したのに消して ref を復元した事故が 1 度ある。競合したら `origin/main` に rebase して force push）。複数 PR が同じ `requirements.md` の行を触るなら順番にマージし、後のものは rebase
- `gh pr create` / `gh pr edit` / `gh issue view` / `gh issue create` はこのリポジトリで Projects (classic) の非推奨エラーを出して失敗する。Issue の作成も `gh api -X POST repos/<o>/<r>/issues --input -`、閲覧は `gh api repos/<o>/<r>/issues/<n>`。`gh api -X POST repos/<o>/<r>/pulls --input -` と `-X PATCH repos/<o>/<r>/pulls/<n>` を使う。ラベルは `issues/<n>/labels`、マイルストーンは `issues/<n>` の PATCH（W2 は `milestone: 2`）。レビューコメントへの返信は `pulls/<n>/comments/<id>/replies`。`gh pr merge --squash --delete-branch` は使える（オーナーの LGTM の後）。
- Codex（`chatgpt-codex-connector[bot]`）が PR をレビューする。指摘は `pulls/<n>/comments` で読み、直して返信する。P1 は設計に関わることが多い。指摘の優先度（P0〜P3）は本文の `P<n> Badge` で読む。扱いとマージ条件は `docs/workflow.md`「Codex レビュー」に従う（再レビューは P0 / P1 を直したときだけ 1 回まで、`has_unresolved_findings` はマージ条件にしない）。再レビューは Issue コメントに `@codex review` と書くと 3〜4 分で走る。
- **ブランチは必ず `origin/main` から切る**（マージ済みのローカルブランチから切ると squash との差で conflict する）。スクリプトで文書を編集したら、コミット前に `wc -l` と `grep -c '^## '` で行数と見出し数を確かめる（空文字列の `replace` で全文が複製された事故が 1 度ある）。
- `gh issue comment` に `--jq` は無い（成功したように見えて何も書かれない）。コメントは `gh api repos/<owner>/<repo>/issues/<n>/comments --jq length` で届いたか確かめる。
- Node は 22 系が入っている（CI・本番は 26）。pnpm は `corepack enable`（`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`）。
- integration テスト用 Postgres: `apt-get update && apt-get install -y postgresql-16 && service postgresql start`、`postgres` ユーザーのパスワードを `postgres` に、DB `gamefeed_test` を作って `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/gamefeed_test`。コンテナが休むと落ちるので、テスト前に `service postgresql start`。
- `drizzle-kit generate` は列の追加 / 改名を対話で聞いてくるが TTY が無いので止まる。Python の `pty` で子プロセスを起こし、`created or renamed` が出るたびに `\r` を送る（#83 のやり方）。生成 SQL は必ず読む: 列挙型の作り直しで `SET DEFAULT` が `SET DATA TYPE` より前に出て失敗した（`DROP DEFAULT → SET DATA TYPE → SET DEFAULT` に並べ替え）。ビュー・トリガーが依存する列を変えるときは先に custom マイグレーションで落とす
- DB テストで拒否を複数回試すときは `rejects(tx, fn, re)`（`db.spec.ts`。`tx.transaction` のセーブポイントで包む）。Postgres は 1 文失敗するとトランザクションが abort するので、素の `await expect(...).rejects` は 1 テストに 1 回しか使えない。`now()` はトランザクション内で同じ値なので「変更した」ことを見るテストには `now() + interval` を使う
- バックグラウンドで dev サーバを動かすなら `setsid nohup ... &`。`pkill -f` は自分のシェルまで殺すので使わない。
- このコンテナから `*.vercel.app` には届かない（curl は 000、Claude の fetch ツールは Vercel に弾かれて "server error"）。本番の確認はオーナーの curl を正とする。
- ネットワークの許可先は GitHub・npm・PyPI・Ubuntu apt 程度。Supabase・Vercel・Google には届かない。
