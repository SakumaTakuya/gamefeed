# MCP サーバ（mcp）

2026-11-08 作成。前提は `product.md` 9（作る側のループ）、`game-contract.md` A.11 / A.12（静的検査と投稿の流れ）、`data-model.md` A.3（`users` / `games` / `posts`）、`moderation.md` A.2 / A.5（投稿状態と信頼スコア）、`security.md` A.5 / A.8（配信可否と認証）。読む人は `apps/api` の `mcp.ts` と「作る」ページの実装者、ツール説明文を直す人。
節番号は `mc#A.6` のように参照する。A 部が規約、B 部が理由。

作る側は AI チャットから離れない（`product.md` 9）。MCP サーバはそのための入口で、公開するのはツール 3 本とリソース 1 つだけ。取り消せない操作（削除）は含めない。

---

# A. 規約

## A.1 用語

| 用語 | 意味 |
| --- | --- |
| クライアント | MCP クライアント。一次対象は Muse（iOS）と Claude のカスタムコネクタ |
| ツール | `publish_game` / `list_my_games` / `unpublish_game` |
| リソース | `gf://guide`。`game-contract.md` の A 部の本文 |
| 下書き | `base_status = draft` の投稿。`publish_game` が作り、置き換えられる（`moderation.md` A.2） |
| 試遊 URL | 下書きを作者が遊ぶ Host のページ。`<app-origin>/draft/<post_id>`（A.9） |
| 公開 | 下書きを `limited` / `public` にすること。以後は不変 |
| 説明文 | ツールとリソースの `description`。AI が読む（A.4） |

## A.2 サーバと認証

| 項目 | 規則 |
| --- | --- |
| エンドポイント | `POST /api/mcp`（Streamable HTTP）。MCP 公式 SDK v2、stateless（セッション ID を持たない。B.6） |
| 認可 | OAuth 2.1（PKCE）。DCR と CIMD の両方を受ける。認可サーバはアプリと同居（Better Auth。`security.md` A.8） |
| スコープ | `games`（1 つだけ、暫定）。3 本のツールすべてに要る |
| 主体 | アクセストークンの `sub` が `auth_user.id` = `users.id`。MCP サーバは API の関数を同じプロセスで呼び、HTTP を中継しない |
| トークンなし | 401 と `WWW-Authenticate: Bearer resource_metadata=…`（R-9-1） |
| `users.status` | `banned` はトークンを無効として 401。`post_restricted` は `publish_game` だけ error `post_restricted`（`moderation.md` A.5） |
| サーバ情報 | `name: "gamefeed"`、`version` はデプロイのコミット短縮ハッシュ |
| 未設定 | `DATABASE_URL` / `R2_*` / KV の変数（A.8）がなければ `publish_game` は 503 `not_configured`（文面に足りない変数名を入れる。値は入れない）。他は DB だけで動く。`unpublish_game` は KV が未設定なら KV を書かずに成功する |

## A.3 ツールとリソース

### `publish_game`

| 入力 | 型 | 規則 |
| --- | --- | --- |
| `html` | string | 必須。128 KB まで（`game-contract.md` A.2） |
| `title` | string? | 省略時は `<title>`。前後の空白を除いて 1〜40 文字（書記素クラスタ数。`gf:verb` と同じ数え方）。省略して `<title>` が 40 文字を超えるなら `invalid`（切り詰めない。B.8） |
| `prompt` | string? | 作者が AI に頼んだ文。1000 文字まで（書記素クラスタ数）。省略時は空 |
| `post_id` | string? | 既存の下書きを置き換える。自分の `draft` 以外は error |
| `publish` | boolean? | `true` でそのまま公開する。既定 `false` |

| 出力 | 型 | 意味 |
| --- | --- | --- |
| `post_id` | string | `gf:` 接頭辞なしの ULID |
| `status` | `draft` / `limited` / `public` / `unpublished` / `restricted` | 結果の投稿状態。`unpublished` / `restricted` は同一内容の既存投稿を返したとき（A.7）だけ |
| `url` | string | `draft` なら試遊 URL、公開後はゲームページ（A.9） |
| `warnings` | `[{code, message}]` | 静的検査の警告（`game-contract.md` A.11） |
| `reused` | boolean | 同一内容の既存投稿を返したとき `true`（A.7） |

### `list_my_games`

入力なし。自分の投稿を `updated_at` の降順で最大 50 件。MCP の `structuredContent` はオブジェクトでなければならないので、一覧は `{games: [...]}` の `games` に入れる。

| 出力（1 件） | 意味 |
| --- | --- |
| `post_id`, `title`, `status`, `url` | `status` は投稿状態（`restricted` を含む 6 値） |
| `calibration` | `uncalibrated` / `calibrated` / `review` / `invalid` |
| `plays`, `likes` | `post_stats.n` と、`likes` を `post_id` で数えた件数 |
| `calibration_remaining` | 校正までの残りプレイ数（`uncalibrated` のとき。20 − `n`） |
| `restricted_reason` | `restricted` のときだけ。通報カテゴリの集計（`moderation.md` A.4）。`{category: count}`。`resolution = dismissed` の通報は数えない（B.9） |
| `published_at`, `updated_at` | ISO 8601 |

### `unpublish_game`

| 入力 | 規則 |
| --- | --- |
| `post_id` | string。振る舞いは `moderation.md` A.2 の `unpublish` の行（`limited` / `public` → `unpublished`、`draft` / `unpublished` は何もせず成功、`removed` は `invalid_state`、他人は `not_found`） |

出力は `{post_id, status}`。`posts.updated_at` は変えない（内容の更新ではなく、下書きの自動削除の基準なので）。

### リソース `gf://guide`

`game-contract.md` の A 部（A.1〜A.13）の本文を `text/markdown` で返す。本文は `pnpm --filter @gamefeed/api gen:guide` がリポジトリから `apps/api/src/guide.gen.ts` に取り込み、コミットする。`game-contract.md` の A 部とずれていれば CI のテストが落ちる（B.9）。サーバの `version` と一緒に変わる。URI は 1 つだけで、一覧（`resources/list`）に出す。

## A.4 説明文（AI が読む。暫定）

ツールの `description` は規約の要約と手順で、AI がこれだけを読んで正しく動けるように書く。`gf://guide` を読まずに投稿されたゲームは静的検査で落ちるので、説明文の最初に読む指示を置く。

`publish_game`:

> GameFeed にミクロゲームを投稿する。先にリソース `gf://guide` を読み、その規約（1 ファイルの HTML、`gf:*` メタ、`GF` SDK、使えない API）に沿って HTML を書くこと。
> 初回は下書きになり、`post_id` と試遊 URL が返る。作者に試遊 URL を開いて遊んでもらい、「診断をコピー」で貼られた文に従って直す。直したら同じ `post_id` を渡して再投稿する（内容が置き換わる）。
> `rejected` で返ったら `errors[].fix` のとおりに直して再投稿する。`warnings` は通るが、作者に伝える。
> 作者が公開を望んだときだけ `publish: true` を付ける。公開後は内容を変えられない。直すなら新しい下書きにする。
> 投稿は GameFeed 上でのリミックス（改変と再投稿、元作者の表示つき）を許諾したものとして扱う。作者に伝えておくこと。

`list_my_games`:

> 自分の投稿の一覧。状態（下書き・公開・制限中など）、プレイ数、いいね、校正までの残りを返す。「ランに入りました」は `calibration: calibrated` で分かる。制限中なら理由（通報カテゴリ）が付く。

`unpublish_game`:

> 公開した投稿を非公開にする。取り消せる（作者がサイトで再公開できる）。削除ではない。

`gf://guide`:

> GameFeed のミクロゲーム規約。`publish_game` を呼ぶ前に読む。

説明文の文面は暫定で、AI の挙動を見て直す。変えるときは `product.md` 9 の流れ（下書き → 試遊 → 公開）を変えない。

## A.5 `users` 行の作成と `handle`

#42 の 1。Better Auth のユーザーは `auth_user` に入り、`users`（`handle`、`trust_score`、`status`）は別の行（`data-model.md` A.3）。

| 項目 | 規則 |
| --- | --- |
| いつ | ツールの呼び出し（3 本すべて）と「作る」ページのログイン後の最初のリクエストで、`ensureUser(id)` を同じトランザクションの先頭で呼ぶ。`INSERT … ON CONFLICT (id) DO NOTHING` |
| 初期値 | `trust_score = TRUST_INITIAL`（10）、`status = active` |
| `handle` | `auth_user.name` を slug 化: NFKC 正規化 → 小文字 → `a-z0-9` 以外を `-` に → 連続する `-` を 1 つに → 前後の `-` を除く → 3〜20 文字に切る。衝突したら `-2`, `-3`, … を付ける（20 文字を超えるなら元を縮める）。3 文字未満・空（記号だけ、非ラテン文字だけ）なら `user-<id の末尾 6 文字（小文字）>` |
| 変更 | Phase 2（「作る」ページで変更。一意制約はそのまま） |
| 表示 | `handle` は成績表・系譜表示・運営画面で使う。`auth_user.name` と `email` は公開しない |

`users` 行がないユーザーは投稿を持たない。既存の `auth_user`（PoC でログインしたオーナー）は最初のツール呼び出しで行ができる。

## A.6 `publish_game` の処理順

1 トランザクション（`db.transaction`）で 2〜10 を行い、11〜12 はコミット後。

1. トークンから `sub` を取り、`ensureUser`（A.5）。`users` を `FOR SHARE` し、`status` が `active` でなければ error（`banned` → 401、`post_restricted` → `post_restricted`）
2. `post_id` があれば、自分の `draft` であることを確かめる。他人・存在しない → `not_found`。自分の `draft` 以外 → `invalid_state`
3. `game_hash = sha256(html)` を計算する。`post_id` がなければ同一内容の確認（A.7）: 自分の投稿に同じ `game_hash` があれば、上限も静的検査も通さずにその投稿を返す（`removed` なら `invalid_state`）。下書きなら `title` / `prompt` を更新してコミットし、11 へ（8 を通らないので、`publish: true` が付いていても公開しない。A.7）
4. `post_id` がなければ、上限を見る: 自分の `draft` が 10 件 → `limit`（`reason: drafts`）。当日の新規下書きが `PUBLISH_LIMIT_NEW` / `PUBLISH_LIMIT`（`moderation.md` A.5）→ `limit`（`reason: rate`）。置き換えは数えない。「当日」は JST の 0 時で区切り、`posts.created_at` が当日の自分の行を状態を問わず数える（B.8）
5. 静的検査（`game-contract.md` A.11）。拒否が 1 つでもあれば `rejected`（`errors[]` に `code`, `message`, `fix`, `line?`）。何も書かない
6. `games` に `ON CONFLICT (hash) DO NOTHING` で入れる（`meta` は検査結果、`stored_at` は NULL）
7. `post_id` あり: `posts.game_hash`, `title`, `prompt`, `updated_at` を更新。なし: `posts` を `draft` で挿入（`tree_id` は新規。`parent_id` は NULL。リミックスは Phase 2）
8. `publish: true` なら公開: `trust_score` で `limited` / `public` を決め（`moderation.md` A.2）、`published_at` を入れる。サムネは公開後のジョブが作る（A.9）
9. `warnings` を組み立てる
10. コミット
11. `games.stored_at` が NULL なら HTML を R2 に置き（A.8）、成功したら `stored_at` を入れる。失敗したら `storage_failed`（12 を書かない）
12. KV `serve:<post_id>` を書く（`security.md` A.5）。`stored_at` が NULL の間は書かない。失敗はリトライ、日次の突き合わせで直る

6 と 11 の順（DB → R2）は、R2 にあって DB にないものを作らないため。R2 の成否は「この呼び出しが行を挿入したか」ではなく `stored_at` で判定するので、11 が失敗した後に同じ入力を呼び直すと 3 の同一内容で同じ投稿に戻り、11 だけやり直す。日次の突き合わせは `stored_at` が NULL のまま 1 時間以上経った `games` を再アップロードする。

## A.7 同一内容

#42 の 3。`games` は HTML のハッシュで重複排除される。

| 状況 | 規則 |
| --- | --- |
| `post_id` なしで、自分の `draft` に同じ `game_hash` がある | 新しい行を作らず、その下書きの `title` / `prompt` を更新して同じ `post_id` を返す（`reused: true`）。省略された項目も既定値（`<title>` / 空）で上書きする。`publish: true` が付いていても公開しない（`status: draft` のまま返る。公開するには `post_id` を付けて呼ぶ）。上限と当日の件数は消費しない |
| `post_id` なしで、自分の `limited` / `public` / `unpublished` に同じ `game_hash` がある | 新しい行を作らず、その投稿を返す（`reused: true`、`status` はその投稿の状態）。`title` / `prompt` は変えない（公開後は不変）。`publish: true` が付いていても何もしない |
| `post_id` なしで、自分の `removed` に同じ `game_hash` がある | 別投稿として扱わない。error `invalid_state`（運営が消した内容を再投稿させない） |
| 自分の投稿の複数が同じ `game_hash` を持つ（置き換えは同一内容を確認しないので起こりうる） | `removed` が 1 つでもあれば `invalid_state`。なければ `updated_at` が最も新しい投稿を上の行の規則で返す |
| `post_id` あり | 同一内容の確認はしない。置き換え先が決まっている |
| 他人の投稿と同じ `game_hash` | 気にしない（`games` の行を共有するだけ。`data-model.md` B.1） |

同一内容の確認は上限と静的検査より先（A.6 の 3）。上限に達していても、同じ内容の再送は既存の投稿に戻るだけで新しい行を作らない。

## A.8 保存

#42 の 4。

| 項目 | 規則 |
| --- | --- |
| 保存先 | Cloudflare R2 `gamefeed-games`、キー `games/{hash}.html`（`data-model.md` A.6） |
| 書き方 | S3 互換 API に SigV4 で `PutObject` だけ。AWS SDK は入れない（B.4）。`Content-Type: text/html; charset=utf-8`、`If-None-Match: *` は付けない（同じ内容の上書きは無害） |
| 環境変数 | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`（`https://<account_id>.r2.cloudflarestorage.com`）, `R2_BUCKET`。KV（`security.md` A.5）は `CLOUDFLARE_API_TOKEN`（Workers KV Storage の Edit だけ）, `CLOUDFLARE_ACCOUNT_ID`, `KV_NAMESPACE_ID`。Vercel と GitHub Secrets にだけ置く |
| テスト | fake のストレージ（メモリ）で回す。R2 への実書き込みは plan#2 の配信と合わせて手動（manual） |
| 読む側 | 配信 Worker は R2 バインディングで読む（`security.md` A.5）。API は読まない |

## A.9 URL

| URL | 誰が | 内容 |
| --- | --- | --- |
| `<app-origin>/draft/<post_id>` | 作者（ログイン要） | 試遊ページ。Host が `GET /api/posts/{id}/play-token` で試遊トークンを取り、`<games-origin>/p/<post_id>/?t=…` を iframe に入れる（`security.md` A.5）。デバッグ表示・「診断をコピー」・「公開」ボタン（`product.md` 9） |
| `<app-origin>/g/<post_id>` | 誰でも | ゲームページ（`run.md` A.14）。`limited` / `public` 以外は `not_found` |
| `<app-origin>/me` | 作者 | 「作る」ページ。自分の投稿一覧（`list_my_games` と同じ内容）、接続プロンプト、再公開・非公開・下書きの削除 |

`publish_game` が返す `url` は `draft` なら試遊ページ、公開後はゲームページ。配信オリジンの URL は返さない（B.5）。

公開後の静止サムネは公開直後のジョブが決定論ハーネスを入力なしで 1 回実行して作り（`scoring.md`、`data-model.md` の `thumb_key`）、できるまでゲームページは「？」の枠を出す。`thumb_key` が入るまで新作枠に入らない（`post_eligibility`）。固まる・例外で止まる・`GF.timeLimit` を過ぎても終わらないゲームは、このジョブが `thumb_key` を入れずに `calibration = invalid` にして運営のキューに出す。`GF.end()` を呼ばず制限時間で終わるのは正常（`game-contract.md` A.4）。プレビュー動画は作者以外の最初の結果から作る（`product.md` 8、`posts.preview_key`）。`publish_game` の応答はジョブを待たない。

## A.10 エラー

ツールの失敗は MCP の `isError: true` で、`structuredContent` に `{code, message, errors?, reason?}`。`message` は日本語で、AI がそのまま作者に見せられる文。

| `code` | HTTP 相当 | いつ | AI がすること |
| --- | --- | --- | --- |
| `rejected` | 422 | 静的検査の拒否。`errors[]` に `code`, `message`, `fix`, `line?` | `fix` のとおり直して同じ `post_id` で再投稿 |
| `not_found` | 404 | `post_id` が自分の投稿でない（存在を漏らさない） | 作者に確認 |
| `invalid_state` | 409 | `post_id` が `draft` でない、`removed` の内容の再投稿、`unpublish_game` に `removed` | 新しい下書きとして出す |
| `limit` | 429 | `reason: drafts`（10 件）/ `rate`（当日の件数） | 作者に伝える。`drafts` なら不要な下書きを「作る」ページで消してもらう |
| `post_restricted` | 403 | `users.status = post_restricted` | 作者に伝える（運営に連絡） |
| `storage_failed` | 503 | R2 への書き込み失敗 | 同じ入力でもう一度呼ぶ |
| `not_configured` | 503 | 環境変数不足 | 作者に伝える |
| `invalid` | 400 | 入力の型・長さ違反 | 直す |

認証の失敗（401）はツールの外で起き、MCP の HTTP 応答として返る。

## A.11 ライセンスとリミックス

| 項目 | 規則 |
| --- | --- |
| 許諾 | 投稿は投稿時点で「GameFeed 上でのリミックス（改変と再投稿）を無条件に許諾する」。CC BY 4.0 相当。派生は元作者の表示（系譜表示、`data-model.md` の `parent_id`）を伴う。元が `removed` / `unpublished` になっても派生は残る（`moderation.md` A.3 の系譜表示） |
| 同意 | 説明文（A.4）に書き、AI が作者に伝える。「作る」ページの接続プロンプトの横にも書く |
| リミックス | Phase 2。`fork_game(post_id) → {html, title, prompt, fork_token}` と `publish_game` の `fork_token` を予約する。`fork_token` を伴わない `parent_id` は信用しない（旧 9.1）。MVP の `publish_game` は `parent_id` を受けない |
| 運営の操作・削除 | ツールに含めない。Muse のカスタムコネクタはツール単位の許可を持たないため、取り消せない操作は入れない（B.1） |

## A.12 検査する性質

| ID | 性質 | 担保 |
| --- | --- | --- |
| C1 | ツール 3 本とリソース 1 つだけが `tools/list` / `resources/list` に出る | R-mc.A3-1 |
| C2 | `publish_game` は静的検査の拒否で何も書かない（`games` / `posts` / R2 / KV） | A.6 の 4、R-9-3 |
| C3 | 同じ入力を 2 回呼んでも投稿は 1 つ（`reused`）。上限を消費しない | A.7、R-mc.A7-1 |
| C4 | `publish: true` の結果は `trust_score` で `limited` / `public`（`moderation.md` A.2） | R-mo.A2-1 |
| C5 | 初回のツール呼び出しで `users` 行ができ、`handle` が一意 | R-mc.A5-1 |
| C6 | 他人の `post_id` は `not_found` で、存在しない ID と同じ応答 | R-mc.A10-1 |
| C7 | DB にあって R2 にないゲーム（`stored_at` NULL）は配信されない（KV を書かない） | A.6 の 11〜12、R-mc.A6-1 |

---

# B. 解説（規則の理由と却下した案）

## B.1 ツールを 3 本に絞る理由

旧 9.1 は `fork_game` / `search_assets` / `get_game` を含む 5 本だった。MVP にアセットとリミックスはない（`game-contract.md` A.6、`product.md` 10）ので、残るのは投稿・一覧・非公開の 3 本。削除を入れないのは、Muse のカスタムコネクタがツール単位の許可を持たず、AI が誤って呼んでも止められないから。`unpublish_game` は可逆（`moderation.md` B.3）なので入れてよい。

## B.2 `users` 行を初回のツール呼び出しで作る理由

Better Auth の `databaseHooks.user.create.after` で作る案は、PoC で既にログインしたアカウント（`auth_user` だけある）の救済が別途要る。ツールと「作る」ページの入口で `ensureUser` を呼べば、既存も新規も同じ経路で行ができ、`users` を読む処理の前に必ず存在する。`handle` を `auth_user.name` から作るのは、ユーザーに入力させる画面を MVP で作らないため。

## B.3 同一内容の規則

AI は同じ HTML を 2 回送ることがある（再試行、`post_id` を忘れた、会話が切れて再開した）。そのたびに下書きが増えると I11 の 10 件をすぐ食い潰す。`games` がハッシュで重複排除されるので、同じユーザーの同じ内容は同じ投稿とみなすのが自然。公開済みの投稿と同じ内容が来たときに新しい下書きを作らないのは、「同じゲームが 2 本一覧に並ぶ」状態を作らないため。別の投稿として出したいなら 1 バイトでも変える（`gf:target` でもよい）。

同一内容の下書きに戻ったとき `publish: true` を無視するのは、「同じ内容の再送は既存の投稿に戻るだけ」という規則を 1 つに保つため（#91）。戻った先で公開まで進める案は、AI が `post_id` を忘れた「公開して」が 1 往復減るが、再試行のつもりの再送が公開（取り消せない不変化）を起こしうるので採らない。応答が `status: draft` なので、AI は `post_id` を付けて呼び直せる。省略された `title` / `prompt` を既定値で上書きするのは、入力の規則をそのまま適用すれば同じ呼び出しの再試行が冪等になるため。渡された項目だけ更新する案は、同じ入力でも前の状態によって結果が変わる。

## B.4 R2 に SDK なしで書く理由

必要なのは `PutObject` 1 つで、AWS SDK v3 はそれだけのために Vercel の関数サイズとコールドスタートを増やす。SigV4 は 100 行で書ける。読む側は Worker のバインディングで、S3 API を使わない。

## B.5 試遊 URL が Host のページである理由

配信オリジンの URL（`<games-origin>/p/<post_id>/?t=…`）を AI に返すと、トークンが会話ログに残り、10 分の失効までの間だけとはいえ AI クライアントの履歴に鍵が置かれる。Host の試遊ページなら作者のログインが要り、トークンは Host がその場で取る。デバッグ表示と「診断をコピー」も Host のページにしか置けない。

## B.6 stateless にする理由

Vercel の関数は呼び出しごとに別のインスタンスで動きうる。MCP のセッション ID を持つと、その対応表を外に置く必要が出る。3 本のツールはどれも 1 呼び出しで完結し、状態は DB にしかないので、セッションなしで困らない。

## B.7 `theme_id` を受けない理由

旧 9.1 は `theme_id`（省略時はお題「フリー」）を受けていた。新しい `product.md` ではお題は運営が公開済みの投稿から 10 本を選ぶもので、作者が応募するものではない（`product.md` 8、`data-model.md` の `theme_posts`）。エンドレスは `theme_id` が NULL のランなので、投稿側にお題の列はない。

## B.8 上限の数え方、当日の境界、文字数

#91。「当日」を JST の 0 時で区切るのは、対象が日本の大学生で、デイリーのお題（`run.md` A.2）と同じ境界にすると「今日」の意味が 1 つで済むため。UTC の 0 時は JST の朝 9 時に枠が戻ることになり、直近 24 時間の移動窓は「いつ戻るか」を作者に説明しにくい。

件数を `posts.created_at` で数えるのは、新しい表も列も要らないため。置き換えは行が増えないので自然に数えない。穴は、下書きを消すと行が消えて枠が戻ること（未解決）。

`title` を省略して `<title>` が 40 文字を超えるときに切り詰めないのは、黙って変えた題が一覧に並ぶより、AI に短い題を渡させる方が作者の意図に合うため。`<title>` 自体の長さは `game-contract.md` で縛らない（ゲーム内の表示は作者のもの）。文字数を書記素クラスタで数えるのは `gf:verb`（`game-contract.md` A.3）と揃えるため。

## B.9 `restricted_reason` の数え方と `gf://guide` の取り込み方

`restricted_reason` から `dismissed` を除くのは、運営が退けた通報を「制限の理由」として作者に見せると、直すべきでない点を直させてしまうため。`open` と `upheld` は数える（自動制限は `open` の重みで起きる）。

`gf://guide` をビルド時に取り込む案（esbuild のローダで `.md` を束ねる）は、Vercel のビルド・vitest・tsx の 3 つで同じ設定が要り、どれかで外れると本文が空のまま動く。生成物をコミットして CI で文書との一致を見れば、どの実行環境でも同じ本文になり、ずれは PR で見つかる。代わりに、`game-contract.md` の A 部を直す PR は `gen:guide` の実行が要る。

---

## 未解決

- 説明文（A.4）の文面。Muse と Claude で読み方が違えば直す
- `prompt` の上限（1000 文字）と `title` の上限（40 文字）。暫定
- 当日の件数は `posts.created_at` で数えるので、下書きを消すと枠が戻る（5 件作る → 消す → また 5 件）。「作る」ページの下書き削除を実装するときに、削除で戻らない数え方（`users` に日付と件数を持つ等）にするか決める
- `list_my_games` の 50 件。Phase 2 でページングを入れるか
- 公開直後のジョブ（決定論ハーネスの実行環境）。Vercel の関数ではブラウザを動かせないので、Cloudflare の Browser Rendering か別のワーカーになる。plan#2 で決める
- スコープを `games` の 1 つにしたが、CIMD で `scopes_supported` に何を出すか。`games` だけ
