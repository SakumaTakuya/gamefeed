# GameFeed — 開発ルール

このリポジトリは AI（Claude Code / Claude）が運用する。人間のオーナーは方針を決め、AI が Issue を切り、実装し、PR を出し、マージする。
迷ったら「仕様書 → 計画書 → このファイル → docs/」の順で正を探す。

## 正とする文書
- プロダクト定義: `docs/product.md`（節番号で参照する。例: `product#5.2`）。規則の理由と却下した案は規則の隣に書いてある。変更の経緯は `type:spec` の Issue と PR 本文に残す（決定の記録ファイルは持たない）
- 仕様の各文書（2026-11-06 の分割、#43）: `docs/game-contract.md`・`protocol.md`・`run.md`・`scoring.md`・`security.md`・`moderation.md`・`data-model.md`・`mcp.md`。ファイル名と節番号で参照する（例: `protocol#3`）。まだ存在しない文書は順次追加する
- 旧 `docs/spec.md` は削除済み。`spec#x.y` の参照が残っている Issue・PR・要件 ID は、その記述を正として実装してはいけない。対応する新文書は Issue #43 の対応表で引く
- 計画書: `docs/plan.md`（WBS 番号で参照する。例: `plan#9`）
- 要件→テスト対応表: `docs/requirements.md`
- テスト方針: `docs/testing.md`
- 作業の流れ: `docs/workflow.md`
- 現在地と次の一手: `docs/status.md`（セッション開始時に最初に読む）

仕様と実装がずれたら、実装を直すか仕様書を直す。黙ってずらさない。
仕様を変えるときは `type:spec` の Issue を切り、該当する `docs/*.md` を直す PR（`spec:` コミット）を出してオーナーの承認を待つ。`product.md` の「決定」を変える PR は、却下した案とその理由を規則の隣に残す。AI が自分でマージしない。

## 構成（モノレポ、pnpm workspaces）
```
apps/web       Vite + React SPA（ラン再生・お題・投稿試遊・運営画面）
apps/api       Hono（REST API・Better Auth・MCP サーバ）。Vercel の api/ から配る
apps/games     Cloudflare Worker（ゲーム HTML 配信、R2、CSP）
packages/sdk   Guest 側 SDK（GF.*）と Host 側ブリッジ、メッセージスキーマ
packages/domain 状態機械・静的解析・ラン生成など純粋なドメインロジック
docs/          プロダクト定義（product.md）・仕様の各文書・計画書（plan.md）・方針文書
```
- 依存の向き: `web`/`api`/`games` → `sdk`/`domain`。逆は禁止。`domain` は Node/ブラウザ両対応で、I/O を持たない。
- TypeScript strict。`any` は理由をコメントして使う。

## 作業の流れ（要約。詳細は docs/workflow.md）
1. 作業はすべて Issue から始める。Issue のない変更は作らない（typo 修正も Issue を切る。1 行でよい）。
2. ブランチ `type/<issue番号>-<短い説明>`（例: `feat/12-host-state-machine`）。
3. **テストを先に書く**（docs/testing.md）。Red → Green → Refactor。
4. PR は Issue を `Closes #N` で参照。CI 緑のみ squash merge。レビューは AI 自身が PR 本文で「仕様との対応」「テストで保証したこと」「保証していないこと」を書く。
   Codex レビューは最初の 1 回で終える。P0 / P1 は必ず直し、P2 は小さければ直すか Issue に回し、P3 は直さない。マージ条件は CI 緑かつ P0 / P1 の未対応なし（docs/workflow.md「Codex レビュー」）。
5. マージ後、Issue が閉じたことと `docs/requirements.md` の対応表が更新されていることを確認する。

## コミットとPR
- コミット: `type(scope): 要約 (protocol#3, #12)` 。type は feat / fix / test / docs / chore / refactor / spec。
- 1 コミット 1 意図。テストと実装は同じ PR に入れるが、コミットは「test: 失敗するテスト」→「feat: 通す実装」の順に分けてよい。
- PR 本文のテンプレートを埋める。空欄で出さない。

## 絶対に守ること
- 秘密情報（トークン・鍵・接続文字列）をコミットしない。`.env.example` だけコミットする。
- `main` に直接 push しない（初期セットアップの docs 類だけ例外）。
- サンドボックス（`docs/security.md`）に関わる変更は、`docs/security-checklist.md` の該当項目を PR で再確認する。
- 仕様書に書かれていない振る舞いを「便利だから」で足さない。足したいなら Issue で提案。
- 動作確認を「目視のみ」と決めた要件は、PR 本文に確認手順と結果を書く。

## 使うコマンド
- `pnpm install` — 依存を入れる（Node 26、pnpm 10）
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
