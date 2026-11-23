# PoC 環境（`poc` ブランチ）

体験を 1 人で確かめるための環境。本番（`main`）とはデータが別で、準備の重い規則を省いてある。
**このブランチは `main` にマージしない。** `main` が進んだら `main` を `poc` に取り込む（逆はしない）。
残したいものが見つかったら、`main` 向けに Issue を切って作り直す。

## 本番との違い（`POC_MODE=1` のときだけ効く）

| | 本番 | PoC |
| --- | --- | --- |
| 校正 | 等速の記録 20 件（4 端末以上）で `calibrated` | **公開した瞬間に `calibrated`**。分布は目標点（`gf:target`）から作った仮の 20 件（目標点が上位 1 割あたり）。実プレイが入ると少しずつ置き換わる |
| 公開直後の状態 | 新規アカウントは `limited` | 常に `public` |
| サムネ | 無いと新作枠に入らない（`set-thumb-key`） | 要らない（正規枠に直接入る） |
| 1 日の投稿数 | 新規は 5 件 | 上限なし |
| サンプルゲーム | 1 本ずつ AI から投稿 | `/api/poc` のボタンで 12 本まとめて公開 |

PoC の偏差値は「他人と比べた位置」ではなく「目標点と比べた位置」。目標点が甘いゲームは簡単すぎたり、ミスだらけになったりする。

実装は `apps/api/src/poc.ts`、`publish.ts` の 2 か所、`app.ts` の `/api/poc`、`pages.ts` の `pocPage`。テストは `apps/api/test/integration/poc.spec.ts`。
サンプルを足した・直したら `pnpm --filter @gamefeed/api gen:poc-samples`。

## 構成

- アプリ: Vercel の Preview（`poc` ブランチに固定ドメインを割り当てる）
- DB: 本番とは別の Supabase プロジェクト。`poc` への push のたびに `poc-db-migrate` がマイグレーションを当てる
- 配信: 本番と同じ R2 と KV を読む、もう 1 つの Worker `gamefeed-games-poc`。`poc` への push のたびに `poc-deploy-games` がデプロイする（本番の Worker は本番のアプリにしか埋め込めないので、別に要る）
- R2 と KV は本番と共用（PoC の投稿が本番の保管場所に混ざる。キーは投稿 ID と内容のハッシュなので衝突はしない）

## 最初の準備（オーナーの作業。1 回だけ）

1. **Supabase**: 新しいプロジェクトを作る。接続文字列を 2 つ控える（direct の `:5432` と、pooler の `:6543`）
2. **Vercel → Settings → Domains**: ドメインを 1 つ足し（例 `gamefeed-poc.vercel.app`）、Git Branch に `poc` を指定する。以下この URL を `<POC>` と書く
3. **GitHub → Settings → Secrets and variables → Actions**:
   - Secrets に `POC_DIRECT_URL`（1 の direct のほう）
   - Variables に `POC_APP_ORIGIN` = `<POC>`（末尾スラッシュなし）
4. **GitHub → Actions**: `poc-db-migrate` と `poc-deploy-games` の最新の実行を開いて「Re-run all jobs」。`poc-deploy-games` のログに Worker の URL（`https://gamefeed-games-poc.<アカウント>.workers.dev`）が出るので控える
5. **Google Cloud → OAuth クライアント**: 承認済みのリダイレクト URI に `<POC>/api/auth/callback/google` を足す
6. **Vercel → Settings → Environment Variables**: 環境は **Preview**、ブランチは `poc` に絞って入れる
   - `POC_MODE` = `1`
   - `DATABASE_URL` = 1 の pooler のほう
   - `BETTER_AUTH_URL` = `<POC>`
   - `BETTER_AUTH_SECRET` = 新しい 32 文字以上の乱数（本番と別にする）
   - `VITE_GAMES_ORIGIN` = 4 で控えた Worker の URL
   - 本番と同じ値: `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ENDPOINT`、`R2_BUCKET`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`KV_NAMESPACE_ID`、`GAMES_SIGNING_SECRET`
7. **Vercel → Deployments**: `poc` の最新のデプロイを Redeploy（環境変数は次のデプロイから効く）

## 遊ぶまで

1. `<POC>/api/poc` を開いて Google でログイン
2. 「サンプルゲームをまとめて公開する」を押す（12 本が `OK ... public` と出る）
3. `<POC>/` でエンドレスを遊ぶ。偏差値・ミス・残機・周回の加速が最初から出る。ゲームページ `/g/<post_id>` には偏差値とヒストグラムが出る

AI から投稿するときは、Claude のコネクタに `<POC>/api/mcp` を別名で足す（本番のコネクタと取り違えないよう、PoC を触る間は本番を切っておく）。`publish_game` で `publish: true` にすると、その場で校正済みになる。

## うまくいかないとき

- `/api/poc` が 404: `POC_MODE` が入っていないか、入れた後に Redeploy していない
- 503 `not_configured`: 応答の `missing` に足りない変数名が出る
- ログインで Google のエラー: 5 のリダイレクト URI が `<POC>` と一字一句同じか
- ゲームの枠が真っ白: `POC_APP_ORIGIN` が `<POC>` と違う（Worker が埋め込みを断っている）か、`VITE_GAMES_ORIGIN` が Worker の URL でない
- まとめて公開が `NG storage_failed` / `not_configured`: R2 と KV の 7 変数

## 確かめていないこと

この環境は 1 度も立てていない。確かめたのは、手元の Postgres でのテスト（まとめて公開 → 12 本が校正済み → エンドレスの山札が全部正規枠）と、`wrangler deploy --env poc --dry-run` まで。Vercel のブランチ別ドメインと環境変数の画面の手順は、今の画面と違うかもしれない。
