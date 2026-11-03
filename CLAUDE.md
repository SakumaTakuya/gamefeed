# GameFeed — 開発ルール

このリポジトリは AI（Claude Code / Claude）が運用する。人間のオーナーは方針を決め、AI が Issue を切り、実装し、PR を出し、マージする。
迷ったら「仕様書 → 計画書 → このファイル → docs/」の順で正を探す。

## 正とする文書
- 仕様書: https://claude.ai/artifact/NAPG7cQ1PAXaiJXXVVAJZR（章番号で参照する。例: `spec#6.3`）
- 計画書: https://claude.ai/artifact/7eTGjGg7grfZ3tkJHySVuj（WBS 番号で参照する。例: `plan#9`）
- 要件→テスト対応表: `docs/requirements.md`
- テスト方針: `docs/testing.md`
- 作業の流れ: `docs/workflow.md`
- 現在地と次の一手: `docs/status.md`（セッション開始時に最初に読む）

仕様と実装がずれたら、実装を直すか仕様書を直す。黙ってずらさない。
仕様書は Claude Docs 上にあるので、変更が必要なときは Issue に「仕様変更」ラベルを付けてオーナーに提案し、承認後に反映する。

## 構成（モノレポ、pnpm workspaces）
```
apps/web       Vite + React SPA（ラン再生・お題・投稿試遊・運営画面）
apps/api       Hono（REST API・Better Auth・MCP サーバ）。Vercel の api/ から配る
apps/games     Cloudflare Worker（ゲーム HTML 配信、R2、CSP）
packages/sdk   Guest 側 SDK（GF.*）と Host 側ブリッジ、メッセージスキーマ
packages/domain 状態機械・静的解析・ラン生成など純粋なドメインロジック
docs/          方針文書。仕様そのものは置かない
```
- 依存の向き: `web`/`api`/`games` → `sdk`/`domain`。逆は禁止。`domain` は Node/ブラウザ両対応で、I/O を持たない。
- TypeScript strict。`any` は理由をコメントして使う。

## 作業の流れ（要約。詳細は docs/workflow.md）
1. 作業はすべて Issue から始める。Issue のない変更は作らない（typo 修正も Issue を切る。1 行でよい）。
2. ブランチ `type/<issue番号>-<短い説明>`（例: `feat/12-host-state-machine`）。
3. **テストを先に書く**（docs/testing.md）。Red → Green → Refactor。
4. PR は Issue を `Closes #N` で参照。CI 緑のみ squash merge。レビューは AI 自身が PR 本文で「仕様との対応」「テストで保証したこと」「保証していないこと」を書く。
5. マージ後、Issue が閉じたことと `docs/requirements.md` の対応表が更新されていることを確認する。

## コミットとPR
- コミット: `type(scope): 要約 (spec#6.3, #12)` 。type は feat / fix / test / docs / chore / refactor / spec。
- 1 コミット 1 意図。テストと実装は同じ PR に入れるが、コミットは「test: 失敗するテスト」→「feat: 通す実装」の順に分けてよい。
- PR 本文のテンプレートを埋める。空欄で出さない。

## 絶対に守ること
- 秘密情報（トークン・鍵・接続文字列）をコミットしない。`.env.example` だけコミットする。
- `main` に直接 push しない（初期セットアップの docs 類だけ例外）。
- サンドボックス（spec#5）に関わる変更は、`docs/security-checklist.md` の該当項目を PR で再確認する。
- 仕様書に書かれていない振る舞いを「便利だから」で足さない。足したいなら Issue で提案。
- 動作確認を「目視のみ」と決めた要件は、PR 本文に確認手順と結果を書く。

## 使うコマンド
- `pnpm install` — 依存を入れる（Node 22、pnpm 10）
- `pnpm check` — lint（Biome）→ typecheck（tsc）→ test（Vitest）。PR 前に必ず通す
- `pnpm lint:fix` — 整形と自動修正
- `pnpm --filter @gamefeed/<pkg> test` — 1 パッケージだけ。`vitest` を `run` なしで呼べば watch
- `pnpm --filter @gamefeed/api dev` — API を :3000 で起動（`/api/health`）
- `pnpm --filter @gamefeed/web dev` — SPA を Vite で起動。`/api` は :3000 にプロキシ
- `gh issue list --milestone W1` — 今週の Issue。`gh pr create` → `gh pr merge --squash --delete-branch`

## セッション開始時の手順
1. `docs/status.md` を読む（現在地・次の一手・未検証事項）
2. `gh issue list --milestone <今週>` で残りを見て、`docs/status.md` の順番どおりに 1 つ選ぶ
3. Issue の要件 ID を `docs/requirements.md` で確認し、失敗するテストから書く
4. 終わったら PR → マージ → `docs/status.md` を更新するコミットを次の PR に含める
