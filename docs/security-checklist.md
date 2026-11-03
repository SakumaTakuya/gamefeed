# サンドボックス安全チェックリスト（spec#5, #15）

サンドボックスに関わる変更（`apps/games`、Host の iframe 生成、CSP、SDK のメッセージ処理）の PR では、該当項目を再確認して結果を PR 本文に書く。
侵入テストの本体は計画書 #2（W2、Gate 0）で作り、ここに項目を追加していく。

- [ ] ゲームは別オリジン（`*.games.<domain>`）からのみ配信され、アプリのオリジンでは絶対に実行されない
- [ ] iframe の `sandbox` は `allow-scripts` のみ（`allow-same-origin` を付けない）
- [ ] 配信レスポンスの CSP: `default-src 'none'`、`script-src 'self' 'unsafe-inline'`（SDK インライン分）、`connect-src 'none'`、`frame-ancestors <app origin>`
- [ ] `blob:` / `data:` へのナビゲーションが遮断される
- [ ] Service Worker 登録が失敗する
- [ ] `window.parent` / `window.top` への参照で例外か null になる
- [ ] postMessage の `origin` 検査が Host 側・Guest 側の両方にある
- [ ] Host が描く UI（幕間・結果・ヘッダー）は iframe の上のレイヤで、ゲームが偽装できない
- [ ] 静的解析の禁止識別子リスト（spec#4.4）が更新されていれば、テストも更新されている
