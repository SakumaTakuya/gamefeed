# 現在地と次の一手

新しいセッションはまずこのファイルを読む。更新は PR をマージするたび、または週次レビューで行う。

## 現在地（2026-11-03）
- 計画書 W1（11/3〜11/8）。ルール文書（#1）、スキャフォールド（#3）、CI（#11）、セッション状態機械（#6）が済み、`pnpm install && pnpm check` が緑。
- 仕様書・計画書は 11/3 にミクロゲーム・MCP 一本・趣味前提で改訂済み。同日、#21 で Guest 配信を「投稿ごとのサブドメイン」から「配信オリジン上のパス `/p/<post_id>/` ＋ CSP `sandbox allow-scripts`」に変更（仕様書 rev 38）。
- Vercel（本番 `gamefeed-seven.vercel.app`、hnd1）と Supabase（Tokyo）は稼働。Cloudflare は R2 バケット `gamefeed-games`（APAC）、予算アラート、GitHub Secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` まで済み。
- #4 の残りは Google OAuth だけ（ログイン機能に着手するまで急がない）。ドメイン購入は #21 により不要。

## 次の一手（順番どおりに）
1. **#8 domain: 静的解析** — 外部依存ゼロ。`packages/domain/test/static-check.spec.ts` に R-6.3-* の失敗するテストから書く。`GameMeta` / `InputKind` は `session.ts` のものを使う。
2. **#7 sdk: メッセージスキーマ** — `session.ts` の `SessionEvent` と対応させる。
3. **#10 docs: 侵入テストの下書き** — 文書だけ。spec#5 の 2026-11-03 改訂（パス分け、R-5.3-*）を前提に書く。
4. **#5 MCP PoC** と **#9 DB マイグレーション** — Vercel と Supabase（`DATABASE_URL`）は揃ったので着手できる。Google ログインが要る段階になったら #4 の Google OAuth をオーナーに頼む。

`gh issue list --milestone W1` で残りを見る。`blocked` ラベルの Issue は本文の依存先が閉じるまで触らない。

## 未検証（最初に触るときに確かめる）
- `apps/games` は `wrangler` を入れていない（依存が重いため）。plan#2 で着手するときに `wrangler` と Miniflare を devDependencies に追加する。
- GitHub Secrets（Cloudflare）は作業用 PAT に読む権限がなく存在を確認できていない。plan#2 の初回 CI デプロイで確かめる。
- spec#5.3 の `Cross-Origin-Resource-Policy: same-site` は、sandbox（不透明オリジン）のゲームが自分のアセットを `<img>` 等で読むときに弾かれる可能性がある（不透明オリジンはどのサイトとも same-site にならない）。plan#2 の e2e（R-5.3-2）で実ブラウザで確かめ、弾かれるなら `cross-origin` に変える仕様変更 Issue を切る。
- `apps/games/src/index.ts` の `CSP` 定数は仮のもの。plan#2 で spec#5.3 のヘッダ（`sandbox` ＋ パス指定）に置き換え、R-5.3-* のテストを先に書く。
- Biome の `recommended` で info が 1 件出る。実害なし。

## オーナーに聞かないと決められないこと
- （今はなし。あれば Issue に `owner` ラベルで書く）
