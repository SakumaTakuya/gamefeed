# サンドボックス安全チェックリスト（spec#5, #15）

サンドボックスに関わる変更（`apps/games`、Host の iframe 生成、CSP、SDK のメッセージ処理）の PR では、該当項目を再確認して結果を PR 本文に書く。
侵入テストの本体は計画書 #2（W2、Gate 0）で作り、ここに項目を追加していく。

- [ ] ゲームは Host と別サイトの配信オリジン（`<games-origin>/p/<post_id>/`）からのみ配信され、アプリのオリジンでは絶対に実行されない
- [ ] 配信の全レスポンス（404 含む）に CSP `sandbox allow-scripts` が付き、ゲーム URL を直接開いても不透明オリジンで動く（R-5.3-1, R-5.3-3）
- [ ] CSP の各ソースが自投稿パスと `/lib/` だけを指し、他投稿の `/p/<other>/` を読めない。配信 Worker がリダイレクトを返さない（R-5.3-2, R-5.3-4）
- [ ] 配信オリジンが Cookie を発行せず、Host・ゲームのどちらもストレージを置いていない
- [ ] iframe の `sandbox` は `allow-scripts` のみ（`allow-same-origin` を付けない）
- [ ] 配信レスポンスの CSP が spec#5.3 のヘッダと一致する（`default-src 'none'`、`worker-src 'none'`、`frame-ancestors <app origin>` を含む）
- [ ] `blob:` / `data:` へのナビゲーションが遮断される
- [ ] Service Worker 登録が失敗する
- [ ] `window.parent.document` / `window.top.location.href` などへのアクセスが例外になる
- [ ] Host は postMessage の送り元を `event.source === iframe.contentWindow` で照合する（不透明オリジンなので `event.origin` は常に `"null"`）。Guest 側は親の `event.source === window.parent` を照合する
- [ ] Host が描く UI（幕間・結果・ヘッダー）は iframe の上のレイヤで、ゲームが偽装できない
- [ ] 静的解析の禁止識別子リスト（spec#4.4）が更新されていれば、テストも更新されている
