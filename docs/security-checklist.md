# サンドボックス安全チェックリスト（security.md）

サンドボックスに関わる変更（`apps/games`、Host の iframe 生成、CSP、SDK のメッセージ処理）の PR では、該当項目を再確認して結果を PR 本文に書く。
侵入テストの本体は `docs/manual-tests/sandbox-pentest.md`（plan#2、W2、Gate 0）。各行末の `PT-*` がその手順書の項目、`R-*` が `docs/requirements.md` の要件。

## 配信（apps/games、se#A.2, A.4, A.5）
- [ ] ゲームは Host と別サイトの配信オリジン（`<games-origin>/p/<post_id>/`）からのみ配信され、アプリのオリジンでは絶対に実行されない（PT-5.1-1, R-5.1-1）
- [ ] 配信オリジンが Cookie を発行せず（`Set-Cookie` なし）、Host・ゲームのどちらもストレージを置いていない（PT-5.1-2, R-5.1-2）
- [ ] ゲーム URL の組み立てが Host の 1 関数に閉じている（PT-5.1-3, R-5.1-3）
- [ ] 配信の全レスポンス（404 含む）に CSP `sandbox allow-scripts` が付き、ゲーム URL を直接開いても不透明オリジンで動く（PT-5.3-1, PT-5.3-3, R-5.3-1, R-5.3-3）
- [ ] CSP の各ソースが自投稿パスと `/lib/` だけを指し、他投稿の `/p/<other>/` を読めない。自アセットと `/lib/` は読める（PT-5.3-2, PT-5.3-5, PT-5.3-6, R-5.3-2）
- [ ] 配信 Worker がリダイレクトを返さない（PT-5.3-4, R-5.3-4）
- [ ] 配信レスポンスの CSP が se#A.4 のヘッダと一致する（`default-src 'none'`、`worker-src 'none'`、`frame-src 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`、`frame-ancestors <app origin>` を含む）。`Cross-Origin-Resource-Policy: cross-origin`、`nosniff`、`Referrer-Policy: no-referrer`（PT-5.3-7〜11）
- [ ] `<meta http-equiv>` で CSP を緩められない（PT-5.3-8）
- [ ] 配信可否は KV `serve:<post_id>` で判定し、`ok` 以外は 404。`draft` は有効な試遊トークン（`?t=`）があるときだけ配信し、期限切れ・他の `post_id` のトークンは 404（R-se.A5-1, R-se.A5-2）
- [ ] `Cache-Control` が状態ごとに se#A.4 のとおり（`draft` は `no-store`）
- [ ] `/lib/` は `manifest.json` にある `name@version` だけを返し、`sha256` が一致する（R-se.A9-1）

## 埋め込み（apps/web の Host、se#A.3）
- [ ] iframe の `sandbox` は `allow-scripts` のみ（`allow-same-origin` / `allow-popups` / `allow-top-navigation` / `allow-forms` / `allow-modals` / `allow-pointer-lock` / `allow-downloads` を付けない）（PT-5.2-1〜6, R-5.2-1）
- [ ] `allow` を付けない（tilt は保留）、`referrerpolicy="no-referrer"`、`credentialless`（PT-5.2-7〜9, R-5.2-2）
- [ ] 試遊トークンは `draft` の作者にだけ発行され（`GET /api/posts/{id}/play-token`）、URL の組み立ては `gameUrl()` の 1 関数（R-se.A5-2, R-5.1-3）
- [ ] Host が描く UI（幕間・結果・ヘッダー）は iframe の上のレイヤで、ゲームが偽装できない（PT-5.4-8, R-5.4-5）
- [ ] Host は `X-Frame-Options: DENY`（PT-5.4-14, R-5.4-6）

## 実行時（se#A.7）
- [ ] `window.parent.document` / `window.top.location.href` などへのアクセスが例外になる（PT-5.4-1, PT-5.4-6, PT-5.4-7, R-5.4-1）
- [ ] 外部へのデータ送信（`fetch` / `sendBeacon` / `WebSocket` / `EventSource` / `<img>` / XHR / DNS プリフェッチ）が遮断される（PT-5.4-2, PT-5.4-3, R-5.4-2）
- [ ] `blob:` / `data:` へのナビゲーションが遮断されるか、遷移先も不透明オリジンのまま（PT-5.4-4, R-5.4-3）
- [ ] Service Worker 登録が失敗する（PT-5.4-5, R-5.4-4）
- [ ] 無限ループ・巨大 canvas・音量爆弾で Host のページが巻き込まれない（PT-5.4-11〜13）

## メッセージ（packages/sdk、protocol.md）
- [ ] Host は postMessage の送り元を `event.source === iframe.contentWindow` で照合する（不透明オリジンなので `event.origin` は常に `"null"`）。Guest 側は親の `event.source === window.parent` を照合する（PT-5.4-9, PT-5.4-10, R-5.4-7）
- [ ] 受信メッセージはスキーマ（`parseGuestMessage` / `parseHostMessage`）で検証し、違反は即セッション破棄（R-6.1-1, R-6.1-5）
- [ ] 静的解析の禁止識別子リスト（gc#A.5）が更新されていれば、テストも更新されている

## アプリのオリジン（apps/api、se#A.6, A.8）
- [ ] `X-Frame-Options: DENY`、`frame-ancestors 'none'`、`frame-src` は配信オリジンだけ（R-5.4-6, R-se.A6-1）
- [ ] 運営の操作は `MODERATOR_IDS` に含まれるユーザーだけが呼べる（R-se.A8-1）
- [ ] 秘密情報の追加は `.env.example` にキー名だけ。値はコミットしない
