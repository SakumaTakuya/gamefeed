# 現在地と次の一手

新しいセッションはまずこのファイルを読む。更新は PR をマージするたび、または週次レビューで行う。

## 現在地（2026-11-03）
- 計画書 W1（11/3〜11/8）。ルール文書（#1）とスキャフォールド（#3）が済み、`pnpm install && pnpm check` が緑。
- 仕様書・計画書は 11/3 にミクロゲーム・MCP 一本・趣味前提で改訂済み。
- Vercel / Supabase / Cloudflare のアカウントとドメインはまだない（#4、オーナー作業）。

## 次の一手（順番どおりに）
1. **#6 domain: Host セッション状態機械** — 外部依存ゼロで今すぐ着手できる。`packages/domain/test/session.spec.ts` に R-6.4-* の失敗するテストから書く。
2. **#8 domain: 静的解析** — 同上。`packages/domain/test/static-check.spec.ts`。
3. **#7 sdk: メッセージスキーマ** — #6 の型が決まってから。
4. **#10 docs: 侵入テストの下書き** — 文書だけ。
5. **#5 MCP PoC** と **#9 DB マイグレーション** — #4（オーナー）が済んでから。PoC のコードは #4 を待たずに書けるが、Muse からの実機確認は Vercel に出てから。

`gh issue list --milestone W1` で残りを見る。`blocked` ラベルの Issue は本文の依存先が閉じるまで触らない。

## 未検証（最初に触るときに確かめる）
> gamefeed@ check /home/claude/gamefeed
> pnpm lint && pnpm typecheck && pnpm test


> gamefeed@ lint /home/claude/gamefeed
> biome check .

Checked 30 files in 22ms. No fixes applied.
Found 1 error.
Found 1 info.
 ELIFECYCLE  Command failed with exit code 1.
 ELIFECYCLE  Command failed with exit code 1. を必ず回す。
- `vercel.json` と `api/index.ts`（`hono/vercel`）の組み合わせは Vercel 上で未確認。#4 の後、最初のデプロイで `/api/health` が返るかを見る。だめなら Vercel の Framework Preset を Vite にして `api/` を調整する。
- `apps/games` は `wrangler` を入れていない（依存が重いため）。plan#2 で着手するときに `wrangler` と Miniflare を devDependencies に追加する。
- Biome の `recommended` で info が 1 件出る。実害なし。

## オーナーに聞かないと決められないこと
- （今はなし。あれば Issue に `owner` ラベルで書く）
