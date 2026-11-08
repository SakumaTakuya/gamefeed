# データモデル（data-model）

2026-11-07 作成。前提は `product.md`、`game-contract.md`、`protocol.md`、`run.md`、`scoring.md`。モデレーションの投稿状態と通報の規則は `moderation.md` で決めるが、列と遷移の骨格はここに置く。読む人は API 実装者。
節番号は `dm#A.3` のように参照する。A 部が規約、B 部が理由。

Postgres を正とし、Redis は派生値のキャッシュ、R2 は不変ファイル。不変条件は DB 制約で書けるものは制約にし、書けないものはトランザクション境界で担保して `requirements.md` の行に結ぶ。

---

# A. 規約

## A.1 識別子と主体

| 種類 | 形 | 備考 |
| --- | --- | --- |
| `users.id`, `posts.id`, `sessions.id`, `runs.id` | ULID（文字列） | 時刻順に並ぶ |
| `games.hash` | 正規化後の HTML の SHA-256（hex） | 同じ内容は 1 行 |
| `device_id` | クライアントが生成する 128 bit の乱数（文字列）。`app.example` の localStorage に置く | 匿名の遊ぶ側の主体。認証ではない |
| `actors.id` | ULID。`device_id` ごとに 1 行。ログインすると `user_id` が埋まる | いいね・通報・セッション・ランの主体。分布の窓（`scoring.md` A.4）の単位。匿名と作る側を同じ型で扱う |

遊ぶ側はほぼ全員匿名で、`users` 行を持つのは作る側だけ（`product.md` 9）。主体を参照する列はすべて `actor_id`（`actors` への FK）で、`user_id` を直接持つのは `users` を主語にする表（`posts`、`moderation_actions`）だけ。

## A.2 列挙型

| 型 | 値（記載順） | 決める文書 |
| --- | --- | --- |
| `user_status` | `active`, `post_restricted`, `banned` | `moderation.md` |
| `base_status` | `draft`, `limited`, `public`, `unpublished`, `removed` | `moderation.md`、`product.md` 9 |
| `calibration` | `uncalibrated`, `calibrated`, `review`, `invalid` | `scoring.md` A.7 |
| `session_state` | `open`, `submitted`, `skipped`, `abandoned` | `run.md` A.6, A.9、`scoring.md` A.2 |
| `session_mode` | `play`, `replay` | `protocol.md` |
| `session_via` | `guest`, `timeout`, `error` | `protocol.md` A.7 |
| `verdict` | `provisional`, `accepted`, `rejected`, `flagged` | `scoring.md` A.3 |
| `run_mode` | `endless`, `daily` | `run.md` A.2 |
| `run_end` | `lives`, `limit`, `abandoned` | `run.md` A.7, A.9 |
| `report_resolution` | `open`, `upheld`, `dismissed` | `moderation.md` |
| `moderation_kind` | `restrict`, `restore`, `remove`, `restrict_tree`, `restore_tree`, `ban_user`, `unban_user`, `calibration_confirm`, `calibration_invalidate` | `moderation.md` A.7、`scoring.md` A.7。`unban_user` の操作は Phase 2 |
| `device_kind` | `ios`, `android`, `other` | `scoring.md` A.7（端末差） |
| `asset_type`（Phase 2） | `image`, `sfx`, `model`, `font` | `game-contract.md` A.6（BGM なし） |
| `asset_source`（Phase 2） | `library`, `user` | `game-contract.md` A.6 |

表示用の投稿状態 `restricted` は列挙にない。`base_status` と `indiv_restricted`・`tree_locks` からビューで導出する（A.4）。

## A.3 テーブル

### users（作る側）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `id` | text pk | |
| `handle` | text | unique |
| `trust_score` | int | default 10（`moderation.md`） |
| `status` | `user_status` | default `active` |
| `created_at` | timestamptz | |

### actors（遊ぶ側の主体。匿名を含む）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `id` | text pk | |
| `device_id` | text | unique。クライアント生成の乱数 |
| `user_id` | text null | fk users。ログインした端末は埋まる。1 ユーザーに複数の `actors` 行があってよい（端末ごと） |
| `created_at` | timestamptz | |

匿名の初回アクセスで `device_id` から upsert する。ログイン時に `user_id` を埋める。以後、その端末の過去のセッション・いいね・通報は同じ主体として扱われる。

### themes（デイリーのお題）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `id` | text pk | |
| `slug` | text | unique。`/t/<slug>/<date>` |
| `title` | text | |
| `status` | text | `draft` / `open` / `closed` |
| `created_at` | timestamptz | |

### theme_posts（お題の 10 本）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `theme_id` | text | fk themes |
| `position` | int | 0〜9 |
| `post_id` | text | fk posts |

pk `(theme_id, position)`、unique `(theme_id, post_id)`。`status = open` のお題はちょうど 10 行（公開 API の検査）。日ごとの順序は `position` と日付から決める（`run.md` A.2）。

### games（内容。不変）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `hash` | text pk | |
| `size` | int | ≤ 131072 |
| `r2_key` | text | `games/{hash}.html` |
| `stored_at` | timestamptz null | R2 への書き込みが成功した時刻。NULL の間は配信しない（`mcp.md` A.6） |
| `meta` | jsonb | 静的検査の結果。`{title, verb, input, duration_frames, target, deterministic, warnings[]}`（`game-contract.md` A.3, A.11） |
| `created_at` | timestamptz | |

内容から決まるもの（動詞・入力・長さ・目標点）はすべて `meta` に入り、投稿の属性（お題・サムネ・校正）は `posts` にある（B.1）。

### posts（投稿）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `id` | text pk | |
| `user_id` | text | fk users |
| `game_hash` | text | fk games。`base_status = draft` の間だけ更新可（I10） |
| `title` | text | 既定は `meta.title` |
| `prompt` | text | 作者が AI に頼んだ文。空可 |
| `parent_id` | text null | fk posts、`ON DELETE RESTRICT`。挿入後は変更不可（I1） |
| `tree_id` | text | 根の `id`（I2） |
| `depth` | int | 根は 0（I2） |
| `base_status` | `base_status` | default `draft` |
| `indiv_restricted` | bool | default false |
| `calibration` | `calibration` | default `uncalibrated` |
| `calibration_flags` | jsonb | `{binary, endurance, target_off}`（`scoring.md` A.7 の「印」） |
| `thumb_key` | text null | `thumbs/{post_id}.webp`。公開直後のジョブが決定論ハーネスを 1 回実行して作る（`mcp.md` A.9）。できるまで NULL で、新作枠に入らない（`post_eligibility`） |
| `preview_key` | text null | `previews/{post_id}.mp4`。作者以外の最初の結果の後 |
| `published_at` | timestamptz null | `draft` から出た時刻（I4） |
| `updated_at` | timestamptz | 下書きの自動削除の基準（I11） |
| `created_at` | timestamptz | |

索引: `(tree_id, depth)`、`(user_id, base_status)`、`(base_status, calibration)`（山札の抽選）、`(user_id, base_status, updated_at)`（下書きの上限と期限）。

### sessions（1 手番 = 1 行）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `id` | text pk | |
| `post_id` | text | fk posts、`ON DELETE CASCADE`。行が消えるのは `draft` だけなので、消えるセッションは試遊のもの（`moderation.md` B.6） |
| `game_hash` | text | fk games。発行時の `posts.game_hash` を写す（下書きの試遊で内容が変わっても再現できる） |
| `actor_id` | text | fk actors |
| `device_kind` | `device_kind` | 発行時の User-Agent から |
| `run_id` | text null | fk runs。試遊ページは NULL |
| `turn` | int null | ランの中の手番番号（0 始まり） |
| `mode` | `session_mode` | |
| `seed` | bigint | 32 bit 符号なし |
| `speed` | numeric(4,3) | 1.000 / 1.125 / 1.250 / 1.375 / 1.500 のどれか（CHECK） |
| `time_limit` | int | 発行時の `meta.duration_frames` |
| `miss_below` | int null | 発行時に凍結（`scoring.md` A.6）。校正前・新作枠・デイリー・試遊は NULL |
| `is_new` | bool | 新作枠の手番 |
| `author` | bool | 投稿者本人のセッション（`actors.user_id = posts.user_id`）。分布に入れない |
| `state` | `session_state` | default `open` |
| `via` | `session_via` null | `submitted` のとき非 NULL |
| `score` | int null | 0 ≤ score ≤ 2³¹−1 |
| `frames` | int null | 1 ≤ frames ≤ `time_limit` |
| `log_key` | text null | `replays/{session_id}.json.gz` |
| `verdict` | `verdict` | default `provisional` |
| `deviation` | numeric(4,1) null | 受理時の偏差値（`scoring.md` A.5）。校正前は NULL |
| `issued_at` | timestamptz | |
| `submitted_at` | timestamptz null | `state = submitted` のときだけ非 NULL（CHECK） |

索引: `(post_id, speed, author, verdict, score)`（分布）、`(run_id, turn)` unique、`(actor_id, post_id, submitted_at)`（1 主体 5 件の窓）。

### runs（ラン。凍結値を持つ）

| 列 | 型 | 制約 |
| --- | --- | --- |
| `id` | text pk | |
| `mode` | `run_mode` | |
| `theme_id` | text null | fk themes。エンドレスは NULL |
| `date` | date null | デイリーの日付 |
| `actor_id` | text | fk actors |
| `deck` | text[] | 山札の `post_id`（12 または 10）。予定であり、実行済みの手番は `sessions(run_id, turn)` が正 |
| `new_index` | int | 山札の中の新作枠の位置 |
| `from_run` | text null | fk runs。共有リンクからの再現 |
| `lives` | int | エンドレス 3、デイリー 0 |
| `reached` | int null | 凍結: 到達手番数（`scoring.md` A.9） |
| `avg_deviation` | numeric(4,1) null | 凍結 |
| `symbols` | text null | 凍結: デイリーの記号列 |
| `ended` | `run_end` null | |
| `recorded` | bool | デイリーの初回だけ true（`run.md` A.2） |
| `started_at` | timestamptz | |
| `ended_at` | timestamptz null | |

索引: `(actor_id, started_at)`。初回判定は部分一意索引 `(theme_id, date, actor_id) WHERE recorded` で行い、同じ主体の同日のランが同時に作られても `recorded = true` は 1 行しか入らない（2 本目は一意違反を受けて `recorded = false` で作り直す）。

手番ごとの値は `sessions`（`run_id`, `turn`）にあり、`runs` は集計だけ持つ（`product.md` 5、B.2）。

### likes / reports（主体は `actor`）

| 表 | 列 | 制約 |
| --- | --- | --- |
| `likes` | `post_id`, `actor_id`, `created_at` | pk `(post_id, actor_id)` |
| `reports` | `id`, `post_id`, `actor_id`, `category`, `weight`, `resolution`, `created_at` | unique `(post_id, actor_id)`。主体が匿名（`actors.user_id` が NULL）なら `weight = 0`（受理時の検査、I14） |

### moderation_actions / tree_locks

| 表 | 列 | 制約 |
| --- | --- | --- |
| `moderation_actions` | `id`, `moderator_id null`（fk users。運営。NULL は自動制限、`moderation.md` A.4）, `kind`, `post_id null`, `user_id null`, `reason`, `created_at` | 追記のみ。`restrict` / `restore` は `post_id` と `user_id` のどちらか一方（CHECK） |
| `tree_locks` | `root_post_id` pk, `action_id` fk moderation_actions, `created_at` | |

### Phase 2（定義だけ先に置く）

| 表 | 列 |
| --- | --- |
| `fork_tokens` | `token` pk, `post_id`, `user_id`, `expires_at`, `used_at null` |
| `assets` | `hash` pk, `type`, `size`, `r2_key`, `source`, `uploader_id null`, `scan jsonb`, `created_at` |
| `post_assets` | `post_id`, `name`, `asset_hash`, `required` |

### post_stats（派生。分布のキャッシュ）

| 列 | 型 | 備考 |
| --- | --- | --- |
| `post_id` | text pk | |
| `n` | int | 分布の件数 |
| `scores` | int[] | 昇順。上限 10,000 件（暫定、超えたら分位点 101 点に切り替え） |
| `updated_at` | timestamptz | |

`sessions` から再計算できる。`result` 受理のトランザクションで追加し、verdict が `rejected` / `flagged` に変わる遷移（検証ワーカー）では同じトランザクションでその点数を外す。1 主体 5 件の窓から押し出された古い結果も外す。`miss_below` と偏差値はここから計算する（`scoring.md` 未解決の保持方法は、まずこの形で始める）。整合の検査として、日次で `sessions` から再計算した結果と突き合わせ、ずれていれば作り直す。

## A.4 ビュー

| ビュー | 定義 |
| --- | --- |
| `post_status` | `removed` / `unpublished` / `draft` はそのまま。`indiv_restricted` または祖先（自身を含む）が `tree_locks` にあれば `restricted`。それ以外は `base_status` |
| `post_eligibility` | ランに出せるか: `post_status = public` かつ `calibration = calibrated` なら `normal`、`post_status IN (limited, public)` かつ `calibration = uncalibrated` かつ `thumb_key IS NOT NULL`（公開直後のジョブが通った）なら `new`、それ以外は `none`（`scoring.md` A.8、`moderation.md` A.3 / A.8） |

## A.5 不変条件

| ID | 条件 | 担保 | 由来 |
| --- | --- | --- | --- |
| I1 | `parent_id` を辿ると根に至る（閉路なし）。挿入後に `parent_id` は変わらない | トリガー | `moderation.md`、旧 P5 |
| I2 | 子の `tree_id` は親と同じ、`depth` は親 + 1 | 挿入時に親を `FOR SHARE` | 同上 |
| I3 | `users.status = banned` のユーザーの投稿はすべて `removed`（既に `removed` のものは除く）。`draft` は BAN と同じトランザクションで削除され、残らない | BAN と更新を 1 トランザクション。投稿の挿入時は `users` を `FOR SHARE` で再確認 | `moderation.md`、旧 P6 |
| I4 | `base_status IN (limited, public, unpublished)` なら `published_at` が非 NULL。`thumb_key` は公開直後のジョブが入れる（`mcp.md` A.9） | CHECK | `product.md` 7, 8 |
| I5 | `removed` から出る遷移はない。`unpublished` からは `limited` / `public` にだけ戻れる | トリガー | `product.md` 9、`moderation.md` |
| I6 | `restricted`（導出）から可視への復帰は `moderation_actions.kind = restore / restore_tree` を伴う | 同一トランザクション | `moderation.md` |
| I7 | `sessions` の `open → submitted / skipped / abandoned` は高々 1 回 | `UPDATE … WHERE state = 'open'` の更新行数 | `scoring.md` A.2 |
| I8 | `verdict = accepted` は検証ワーカーだけが書く | コードの経路（MVP）。ロール分離は Phase 2 | `scoring.md` A.3 |
| I9 | `post_assets` の上限（Phase 2） | トランザクションで集計 | `game-contract.md` A.6 |
| I10 | `game_hash`, `title`, `prompt` は `base_status = draft` の間だけ更新できる | トリガー | `product.md` 9 |
| I11 | 1 ユーザーの `draft` は 10 件以下。`updated_at` から 30 日触られていない `draft` は削除される（行を消す。試遊セッションはカスケードで消え、R2 の `replays/` は日次ジョブで掃除） | 挿入時に件数を数える。日次ジョブ | `product.md` 9、`moderation.md` B.6 |
| I12 | `theme_posts` は `status = open` のお題でちょうど 10 行、`position` は 0〜9 で重複なし。`sessions.speed` は 5 値のどれか。`miss_below` が非 NULL なら `run_id` が非 NULL かつそのランが `endless` かつ `is_new = false` | CHECK と発行時の検査 | `run.md` A.3, A.8 |
| I13 | `(run_id, turn)` は一意。`ended_at` が非 NULL のランの `reached` / `avg_deviation` / `symbols` は変わらない | unique、トリガー | `scoring.md` A.9 |
| I14 | `likes` / `reports` は 1 投稿につき 1 主体 1 回。主体が匿名なら通報の `weight = 0` | unique、受理時の検査（`actors.user_id` を見る） | `moderation.md`、`product.md` 3 |
| I17 | `actors.device_id` は一意。1 ユーザーに複数の `actors` があってよいが、1 つの `actors` は 1 ユーザーにしか結びつかない（`user_id` は一度埋まったら変えない） | unique、トリガー | B.3 |
| I15 | `post_stats` は `scoring.md` A.4 の条件を満たす結果だけを含む: `author = false`、`speed = 1.0`、verdict が `provisional` / `accepted`、`frames ≥ 0.9 × time_limit`、1 主体 5 件。verdict の変更と窓からの押し出しで外す | `post_stats` 更新の条件（受理と verdict 変更の両トランザクション）、日次の再計算との突き合わせ | `scoring.md` A.3, A.4 |
| I16 | 同じ `actor_id`・お題・日付で `recorded = true` のランは 1 本 | 部分一意索引 | `run.md` A.2 |

## A.6 Redis と R2

| 場所 | キー / パス | 内容 |
| --- | --- | --- |
| Redis | `rank:{post_id}:accepted`, `rank:{post_id}:provisional` | sorted set、member は `actors.id`、score は最高点（ゲームページの順位） |
| Redis | `rank:weekly:{iso_week}` | 総合。上位 10% 入賞回数（Phase 2） |
| Redis | `draft_count:{user_id}` | 任意。I11 のための件数キャッシュ |
| R2 | `games/{hash}.html` | 不変。`Cache-Control: immutable` |
| R2 | `replays/{session_id}.json.gz` | 入力ログ、`seed`、`speed` |
| R2 | `thumbs/{post_id}.webp`, `previews/{post_id}.mp4` | サーバ描画（`scoring.md` A.10） |
| R2 | `reports/{run_id}.png`, `clips/{run_id}.mp4` | 成績表の画像とクリップ。生成は共有時 |
| R2（Phase 2） | `assets/{hash}.{webp\|ogg\|glb\|woff2}`, `lib/{name}@{version}.min.js` | |

## A.7 現行スキーマとの差分

`apps/api/src/db/schema.ts`（#44 時点）に対して追従が要るもの。追従 Issue はこの文書のマージ後に切る。

| 対象 | 変更 |
| --- | --- |
| `games` | `theme_id`, `verb`, `input`, `duration_frames`, `thumb_key` を削除し `meta jsonb` に。`stored_at` を追加。`duration_frames` の CHECK は `meta` の検査として API 側に |
| `posts` | `controls`, `showcase_key`, `deterministic` を削除（`deterministic` は `meta` へ）。`calibration`, `calibration_flags`, `thumb_key`, `preview_key`, `published_at`, `updated_at` を追加。`base_status` を `draft / limited / public / unpublished / removed` に（`pending`, `expired` を廃止）。I4 の CHECK を `published_at` に |
| `sessions` | `user_id` を `actor_id` に。`post_id` を `ON DELETE CASCADE` に。`game_hash`, `device_kind`, `run_id`, `turn`, `speed`, `time_limit`, `miss_below`, `is_new`, `author`, `via`, `deviation` を追加。`checkpoint`, `opened_at`（→ `issued_at`）を削除。`state` に `skipped` |
| `runs` | `seed`, `game_ids`, `results`, `cleared`, `total` を削除。`user_id` を `actor_id` に。`mode`, `date`, `deck`, `new_index`, `from_run`, `lives`, `reached`, `avg_deviation`, `symbols`, `ended`, `recorded` を追加。ビュー `run_results` は廃止 |
| `reports` | `reporter_id` を `actor_id`（fk actors）に。匿名は受理時に `weight = 0` |
| `actors`, `theme_posts`, `likes`, `post_stats` | 新設 |
| `moderation_kind` | `calibration_confirm`, `calibration_invalidate`, `unban_user` を追加 |
| `asset_type` | `bgm` を削除 |
| `themes` | 10 本は `theme_posts` に。`themes` 自体は列を足さない |

---

# B. 解説（規則の理由と却下した案）

## B.1 内容から決まるものを `games.meta` に、投稿の属性を `posts` に分ける理由

`games` はハッシュで重複排除される不変の内容で、同じ HTML を別の投稿に出すと 1 行を共有する。旧設計が `games.theme_id` と `thumb_key` を持っていたのは、同じ内容を 2 つのお題に出した瞬間に壊れる（#43 のレビュー）。動詞・入力・長さ・目標点は HTML から静的検査で読むので内容側、サムネ・校正・公開状態は投稿側。

## B.2 手番を `sessions` に持ち、`runs` に配列で持たない理由

旧設計の `runs.results[]` は手番の結果と `sessions` の二重管理だった。手番は 1 セッションなので `sessions` に `run_id` と `turn` を持てば足り、`finish` の「3 回目のミス以降を捨てる」も `turn` 順に `sessions` を読むだけで書ける。`runs` には凍結した集計だけを置く。

## B.3 主体を `actors` に一本化し、`device_id` を鍵にする理由

遊ぶ側にアカウントを要求しない（`product.md` 3）。いいね・通報の重複と、分布の 1 主体 5 件の窓には何らかの主体が要る。`device_id` はクライアントが生成する乱数で、消せば別人になるが、それで得られるのは「もう 1 回いいねできる」程度で、通報の重みは 0 なので害がない。IP やフィンガープリントは使わない（精度が低く、同じ家の 2 人を同一視する）。

主体を `(user_id null, device_id)` の 2 列で持つ案は、`likes`・`reports`・`sessions`・`runs` の 4 箇所で `coalesce` の一意索引と窓の索引が 2 本立てになる。`actors` を 1 枚置いて全部 `actor_id` の FK にすれば一意も窓も 1 本で済み、匿名で遊んでいた端末が後からログインしたときに `actors.user_id` を埋めるだけで同じ主体に寄せられる。代償は匿名の初回アクセスで upsert が 1 回増えること。

## B.4 `sessions.game_hash` を写す理由

下書きの試遊では `posts.game_hash` が再投稿で変わる。リプレイと検証はセッション時点の内容に対して行うので、`post_id` 経由では辿れない。公開後は不変なので冗長だが、同じ列で済む。

## B.5 `post_stats` を別表にする理由

偏差値と `miss_below` は分布の順位から出す（`scoring.md` A.5）。毎回 `sessions` を集計すると、手番の発行ごとにそのゲームの全セッションを読むことになる。昇順配列を 1 行に持てば二分探索で済み、`sessions` から再計算できるので正ではなくキャッシュ。1 万件で分位点に切り替えるのは配列の更新コストのため。

## B.6 `draft` を `base_status` に入れる理由

下書き（`product.md` 9）は「作者と直リンクだけが見られる投稿」で、`limited` と見え方が近いが、内容が可変で校正もしない点で別物。`unpublished` も「公開後に止めた」状態として `draft` と区別する（内容は不変、セッションが参照している）。`pending` と `expired` は Showcase 必須をやめたので不要。

## B.7 匿名の通報を重み 0 で受け付ける理由

`product.md` 3 の決定。匿名の通報を受け付けないと、遊ぶ側のほぼ全員が通報できず初期のモデレーションが機能しない。重み 0 なら自動制限には効かず、運営の目視キューの材料にだけなる。同じ主体からの重複は `(post_id, actor_id)` の一意で弾く。

## B.8 お題の 10 本を `theme_posts` に分ける理由

`themes.post_ids text[]` は配列の中身に FK が張れず、削除された投稿や同じ投稿の重複を制約で防げない。お題は運営が手で編集するので、`(theme_id, position)` の主キーと `(theme_id, post_id)` の一意で守る。`runs.deck` は配列のままでよい: ランの生成時にサーバが作る予定で、実行済みの手番は `sessions(run_id, turn)` が正だから。

---

## 未解決

- `device_id` を Cookie にも持つか（localStorage は Safari の 7 日消去に当たる）。消えても害は小さいので localStorage で始める
- `post_stats.scores` の上限 1 万件と分位点への切り替え条件
- `users.handle` の生成規則と、Better Auth の `auth_user` 作成時に `users` 行を作るか初回 `publish_game` 時か（`status.md` の「オーナーに聞くこと」）
- 総合の記録（`rank:weekly`）の定義。Phase 2
