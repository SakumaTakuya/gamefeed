<!--
このファイルが仕様書の正。章番号で参照する（例: spec#6.3）。変更は `spec:` の PR で行う（docs/workflow.md「仕様変更」）。
元は Claude Docs（https://claude.ai/artifact/NAPG7cQ1PAXaiJXXVVAJZR、rev 38）。4 つの図（全体アーキテクチャ・Host 状態機械・投稿状態機械・ロードマップ）は
Markdown に書き出せないため「[embedded content: …]」の 1 行だけ残している。内容は本文の表と同じ。
-->

# ミニゲームフィード プラットフォーム仕様書

Oct 29, 2026 作成 · Nov 3, 2026 改訂（ミクロゲーム対応） · @Takuya Sakuma

## 1. 概要と目的

GameFeed（仮称）は、AIで作られたブラウザミニゲームを縦スワイプで次々に遊ぶフィード型プラットフォームである。投稿はClaude等のAIチャットからMCPツール経由で行い、ゲームは単一HTML（コード）とアセット束として別オリジンのサンドボックスiframeで実行する。ゲーム本体は「入力を受け、描画し、結果を報告する」純粋な部品に限定し、ランキング・いいね・リミックス・モデレーションはすべてプラットフォーム側が持つ。

解く課題は3つ。AI生成でゲーム制作コストがほぼゼロになった一方で、遊ばれる場がない。ゲームは動画と違い「触るまで価値が分からない」ため、フィードの即時性と相性が悪い。そしてユーザー投稿のコードをブラウザで実行することは、設計を誤れば致命的なセキュリティ事故になる。

2026-11-03 改訂：対象ユーザーを大学生、ゲームの型を WarioWare 式のミクロゲーム（5秒・動詞ひとつ・入力ひとつ）、フィードを「お題ごとの連続ラン」に変更した（競合調査 第9節）。投稿経路は、作り手が使っているAI（Muse・Claude 等）にMCPの接続プロンプトを1つ貼るだけでつながることを前提にする。変更が及ぶのは第6〜9章と第12〜13章で、サンドボックスとモデレーションの設計は変わらない。

2026-11-03 改訂（同日・2）：Guest の配信を「投稿ごとのサブドメイン」から「1つの配信オリジン上の投稿ごとのパス（`/p/<post_id>/`）＋ 全ゲームへの CSP `sandbox allow-scripts`」に変更した（第3章、第5.1〜5.4章、第12.3章、第15章）。ドメイン購入・ワイルドカード証明書・Public Suffix List 登録が不要になる代わりに、防御の1層が薄くなる。URL の組み立ては Host の1か所に閉じ込め、一般公開前の侵入テストの結果次第でサブドメイン方式へ戻せるようにする。

設計原則は次の5点で、以降の章はすべてこの原則から導かれる。

1. **ゲームは信用しない**。サンドボックスとCSPで「できないこと」を保証し、静的解析や投稿経路の制限は補助とみなす。
2. **ゲームは決定論的に動く**。入力ログからリプレイできることを規約にし、映像配信コストと「即遊べる」問題を同時に解く。
3. **機能はアプリ側に寄せる**。ゲームとアプリの接点はpostMessageの数種類のメッセージだけにする。
4. **後から締められる構造にする**。投稿状態、通報、系譜（親子関係）はMVP時点でスキーマに持つ。
5. **リミックスを一級市民にする**。すべての投稿はリミックス可を前提とし、派生関係は自動で記録する。

## 2. 用語とコア概念

| 用語 | 定義 |
| --- | --- |
| Game | 投稿された単一HTML。不変（immutable）で、修正は新しいGameの投稿として扱う |
| Post | Gameにメタデータ（タイトル、作者、親、状態、プロンプト）を付けた公開単位。フィードに並ぶのはPost |
| Session | 1人のユーザーが1つのGameを1回遊ぶ単位。開始から結果報告までを含む |
| Replay | Sessionの入力ログ＋シード。ゲーム自身に再生させることで映像の代わりにする |
| Showcase | Postのフィード表示時に流す代表リプレイ。投稿時に作者が録る |
| Fork | 既存Postを親として新しいPostを作る操作。parent_idで系譜が残る |
| Tree | 1つの原型Postから派生したPost全体。モデレーションの一括処分単位 |
| Host | フィードを表示するプラットフォーム本体（app.example）。信頼される側 |
| Guest | iframe内で動くGame。信頼されない側 |
| SDK | Guest側に注入される小さなJS。postMessageをラップし、乱数と時間をHostから受け取る |
| Verdict | Sessionのスコアに対するサーバの判定。accepted / rejected / flagged |
| Asset | 画像・音声・3Dモデル・フォント。コンテンツハッシュで識別する不変ファイルで、投稿をまたいで共有される。コード（index.html）とは別に配信される |

改訂で追加した用語：**ミクロゲーム**（180〜480フレームで勝敗が決まる1本。第6.3章）、**お題**（ミクロゲームを束ねる運営作成のテーマ。`themes`）、**ラン**（お題1つのミクロゲームを幕間を挟んで連続で遊ぶ単位。既定10本、戻れない）、**幕間**（ゲーム間にHostが出す1秒の指示レイヤ。動詞と入力アイコンを表示）、**動詞**（幕間に出す命令形の一言。`gf:verb`）。

## 3. 全体アーキテクチャ

[embedded content: 全体アーキテクチャ · 投稿経路・配信・閲覧の3系統]

信頼境界は2本ある。1本目はMCPサーバーとAPIサーバーの間で、投稿内容はここで静的解析を通るまで信用しない。2本目はHostとGuestの間で、Guestは別オリジン（games.example）から配信され、Hostとの接点はpostMessageだけである。ランキングやいいねはHostがAPIに直接送り、Guestはスコアの「主張」を報告するに過ぎない。

ゲームHTMLは不変オブジェクトとしてS3（R2）に置き、ゲーム配信オリジン上の投稿IDを含むパス（例 `https://<games-origin>/p/g-01hx…/`）で配信する。配信オリジンは Host とは別サイトで、全ゲームに CSP `sandbox allow-scripts` を付けるため、ゲームは直接開かれても不透明オリジンとして動き、ゲーム同士もブラウザ上で隔離される。審査ワーカーは非同期にDBを読み、投稿状態を変更するだけで、配信経路には介在しない。

## 4. ゲームコンテナ規約

ゲームは「コード」と「アセット」に分けて投稿する。コードは `index.html` 1つで 128 KB 以下、アセット（画像・音声・3Dモデル・フォント）は合計 3 MB 以下で、同じ投稿パス（`/p/<post_id>/assets/`）から別ファイルとして配信する。コードの上限はリミックス時にAIのコンテキストへ丸ごと載せるためのもので、アセットはそこに載せる意味がないので分離する。ライブラリはプラットフォームが固定バージョンで配信するホワイトリストからのみ読み込める。

### 4.1 コード

| 項目 | 規約 | 違反時 |
| --- | --- | --- |
| ファイル | `index.html` 1つ。`<script>`と`<style>`はインライン。画像・音声の data: URI は禁止（アセットとして分離する） | 拒否 |
| サイズ | 128 KB 以下（gzip前）。リミックス時にAIのコンテキストへ載せられる上限 | 拒否 |
| 読み込み先 | `./assets/<name>`（自投稿のアセット）と `/lib/<name>@<version>.min.js`（ホワイトリストのライブラリ）のみ。それ以外の `src`, `href`, `url()`, `@import` は禁止 | 拒否 |
| 禁止API（静的） | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `import(`, `eval`, `new Function`, `document.cookie`, `localStorage`, `indexedDB`, `open(`, `location` への代入。アセット取得は `GF.assets.load()` を使う | 拒否 |
| 時間・乱数 | `Math.random`, `Date.now`, `performance.now`, `setTimeout`, `setInterval`, `requestAnimationFrame` の直接使用禁止。SDKの `rng()`, `frame`, `onTick` を使う | 拒否 |
| 入力 | DOMイベント直接購読は可だが、SDK の `onInput` 経由を推奨。直接購読した入力はリプレイに記録されない旨を警告 | 警告 |
| 音声 | `AudioContext` は可。再生開始は `onStart` 以後に限定（自動再生禁止）。音量は SDK の `audio.gain` を経由 | 警告 |
| 画面 | 縦長 9:16 を基準に `100vw × 100vh` にフィットさせる。`<meta name="viewport">` はSDKが注入 | 警告 |
| メタデータ | `<title>` 必須。`gf:duration` / `gf:verb` / `gf:input` の宣言は第6.3章の表に従う | 拒否 |

### 4.2 アセット

アセットは `publish_game` の `assets` 引数で「名前 → コンテンツハッシュ」の一覧として渡し、実体はブラウザのアップロードUIかプラットフォームのCC0ライブラリから来る（第9章）。同じハッシュのファイルは投稿をまたいで1つしか保存しない。

| 種別 | 形式 | 1ファイル上限 | 備考 |
| --- | --- | --- | --- |
| 画像 | WebP, PNG | 256 KB | SVG はスクリプトを内包できるため禁止。PNG は投稿時に WebP へ正規化 |
| 効果音 | Opus（.ogg） | 64 KB | WAV/MP3 で受け取り Opus へ正規化。48 kHz 以下 |
| BGM | Opus 64 kbps 以下 | 512 KB | 60秒ループまで。`required` にできない |
| 3Dモデル | GLB | 512 KB | テクスチャは GLB 内包のみ。外部参照を含むものは拒否 |
| フォント | WOFF2 | 128 KB |  |
| 投稿合計 |  | 3 MB、32 ファイル | `required` 合計は 512 KB まで |

`required` を付けたアセットは Showcase 開始前にロードされ、残りは表示中スロットになってから `GF.assets.load(name)` で取得する（第8.5章）。サーバは拡張子でなくマジックバイトとデコード結果で形式を判定し、MIME を付け直す。

### 4.3 ライブラリ

`/lib/` 以下はプラットフォームが同一オリジンから配信する固定バージョンのライブラリで、初期リストは three.js、pixi.js、matter.js、zzfx。静的解析は既知のパス以外の `<script src>` を拒否する。ライブラリ内部の `Math.random` や `performance.now` 呼び出しは、SDK がグローバルをシード付き実装・フレーム由来の時刻に差し替えることで決定論性を保つ（第7.2章）。matter.js のような物理エンジンは浮動小数の環境差が出うるため、使用時は `gf:deterministic=false` の宣言を推奨する。

### 4.4 静的解析の位置づけ

静的解析は字句レベルの禁止識別子検出であり、難読化（`window['fe'+'tch']`）は検出できない。これは意図的な割り切りで、本当の防御線は第5章のサンドボックスであり、静的解析の役割は「善意の作者が誤って非決定的なゲームや外部参照を投稿する」のを防ぐことにある。静的解析を通過しても、実行時には禁止APIが SDK によって差し替えられている（`fetch` は `./assets/` 限定のラッパー、`Math.random` はシード付き乱数）ため、難読化しても得るものはない。

SDKは投稿HTMLには含めず、配信時にサーバが `<head>` 先頭へ注入する。これにより SDK の更新が全ゲームに即時反映され、作者がSDKを改変する余地もなくなる。

## 5. サンドボックスとセキュリティモデル

防御は「別オリジン」「sandbox属性」「CSP」の3層を重ね、どれか1層が破られてもゲームがHostのデータや他ユーザーに触れないようにする。静的解析と投稿経路の制限は、この3層の外側にある補助線である。

### 5.1 オリジン設計

| オリジン | 役割 | Cookie |
| --- | --- | --- |
| `app.example` | Host。ログインセッション、フィード、API呼び出し | セッションCookie（`SameSite=Strict`, `HttpOnly`） |
| `api.example` | REST API。`app.example` からのみCORS許可 | なし（Bearer） |
| `<games-origin>/p/<post_id>/` | Guest配信専用。投稿ごとに固有パス。全レスポンスに CSP `sandbox allow-scripts` | 一切発行しない |

ゲーム配信オリジンは Host とは別サイト（MVP は `gamefeed-games.<account>.workers.dev`）に置き、投稿ごとの隔離はパスで分ける。配信 Worker は全ゲームのレスポンスに CSP の `sandbox allow-scripts` を付けるため、iframe 経由でも URL を直接開いても、ゲームは常に不透明オリジンとして動き、Cookie・ストレージに触れない。配信オリジンは Cookie を一切発行せず、ストレージも使わないので、ゲームAが配信オリジンに何かを置いてゲームBが読む、という経路は存在しない。これにより Public Suffix List 登録は不要になる。ゲーム URL の組み立ては Host の1関数に閉じ込め、一般公開前の侵入テスト（第15章 #1）の結果次第で投稿ごとのサブドメイン方式へ設定変更だけで戻せるようにする。

### 5.2 iframe sandbox 属性

Hostは次の属性でのみGuestを埋め込む。`allow-same-origin` を付けないことが最重要で、これがないとGuestは「不透明オリジン（opaque origin）」として扱われ、たとえ同一オリジンでもCookie・ストレージ・親DOMに触れない。

```html
<iframe
  sandbox="allow-scripts"
  allow="accelerometer 'src'; gyroscope 'src'"
  referrerpolicy="no-referrer"
  credentialless
  src="https://<games-origin>/p/g-01hx…/">
</iframe>
```

`allow-popups`, `allow-top-navigation`, `allow-forms`, `allow-modals`, `allow-pointer-lock` はいずれも付けない。`credentialless` 属性はサポートブラウザで付与する。未対応ブラウザでも、配信オリジンは Cookie を一切発行しないため影響しない。

### 5.3 Content-Security-Policy

配信 Worker が全ゲームに、投稿IDだけを差し替えた同一形のCSPヘッダを付与する。ゲーム側は `<meta http-equiv>` で緩和できない（ヘッダが優先され、`sandbox` は meta では指定もできない）。

```http
Content-Security-Policy:
  sandbox allow-scripts;
  default-src 'none';
  script-src 'unsafe-inline' https://<games-origin>/p/<post_id>/ https://<games-origin>/lib/;
  style-src 'unsafe-inline';
  img-src https://<games-origin>/p/<post_id>/assets/ blob:;
  media-src https://<games-origin>/p/<post_id>/assets/ blob:;
  font-src https://<games-origin>/p/<post_id>/assets/;
  connect-src https://<games-origin>/p/<post_id>/assets/ https://<games-origin>/lib/;
  worker-src 'none';
  object-src 'none';
  frame-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors https://app.example;
Cross-Origin-Resource-Policy: same-site
X-Content-Type-Options: nosniff
```

各ソースは投稿ごとのパス（`/p/<post_id>/`）と `/lib/` のホワイトリストだけを指すため、ゲームは他の投稿のアセットを読み込めない。CSP のパス照合はリダイレクト後には効かないため、配信 Worker はリダイレクトを返さない。`connect-src` は GLB ローダー等のライブラリが自投稿のアセットを `fetch` するために必要で、配信側は静的ファイルしか返さないため持ち出し経路にはならない。`sandbox allow-scripts` により、ゲームURLを直接開いてもトップレベルで不透明オリジンになり、iframe 内と同じ制限で動く。`frame-ancestors` は他サイトへの埋め込みを禁じるだけで、直接開くことは防がない（その役割は `sandbox` が担う）。残る漏洩経路は `postMessage` の内容と、作者が画像内に情報を仕込むといった帯域外の手段だけで、前者はHost側でスキーマ検証する（第6章）。

### 5.4 脅威モデル

| 脅威 | 対策 | 残存リスク |
| --- | --- | --- |
| HostのCookie・トークン窃取 | 別オリジン + opaque origin + `HttpOnly` | なし |
| 他ユーザー・他ゲームへの干渉 | 投稿ごとのパス + CSP `sandbox` + パス指定の CSP。配信オリジンは Cookie・ストレージを持たない | ブラウザのバグで sandbox が破られた場合、同一配信オリジン上の他ゲーム（公開済みの静的ファイルのみ）に触れうる。実害は小さいが、必要ならサブドメイン方式へ戻す |
| 外部へのデータ送信 | `connect-src` は自投稿パスの静的配信と `/lib/` のみ、外部リソース禁止、ゲームコード側の `fetch` は SDK の `./assets/` 限定ラッパーに差し替え | DNS プリフェッチ等の副作用は `referrerpolicy` と `default-src 'none'` で抑止 |
| フィッシング（偽ログイン画面） | `allow-forms` なし、`form-action 'none'`、iframe外周にHostのUI枠を常時表示 | 画面内に偽UIを描くことは可能。通報で対処 |
| スコア改ざん | Guestのスコアは主張として扱い、サーバが妥当性判定（第10章） | リプレイを偽造する高度な改ざんは検知不能。ランキング上位のみ再検証 |
| リソース枯渇（無限ループ、巨大canvas） | Hostが `requestAnimationFrame` を供給しない。画面外ゲームは `unload`。CPU計測で強制停止 | 瞬間的なタブ重量化 |
| 光過敏・音量爆弾 | 初回ミュート再生、SDKの `audio.gain` 上限、審査ワーカーの輝度変化検知 | 検知前の露出 |
| 不適切画像・文字 | 投稿時の画像分類、サムネ一覧での目視、通報 | 手描きcanvas描画は投稿時に検出できない |
| クリックジャッキング | Hostは `X-Frame-Options: DENY` | なし |

認証はOAuth 2.1（PKCE）で、MCPサーバーはユーザーのアクセストークンをAPIに中継するだけで独自の権限を持たない。`publish_game` スコープのトークンは有効期限1時間、リフレッシュはMCPクライアントのOAuthフローに委ねる。

## 6. ゲームSDK / postMessageプロトコル

HostとGuestの接点は10種類のメッセージだけで、どちらも相手のメッセージをJSONスキーマで検証し、違反は即座にセッション破棄とする。SDKは作者から見ると `GF` グローバル1つで、乱数・時間・入力・制限時間・終了報告をすべてここから受け取る。

### 6.1 メッセージ一覧

| 方向 | type | ペイロード | 意味 |
| --- | --- | --- | --- |
| G→H | `ready` | `{sdk: "1.1", title, verb, input, duration}` | SDK初期化完了。`verb`・`input`・`duration` は `<meta name="gf:*">` から読む。これ以前のHost送信は無視される |
| H→G | `init` | `{session_id, seed, mode: "play"\|"replay", time_limit, inputs?, record?}` | セッション開始準備。`time_limit` は論理フレーム数（既定 300 = 5秒）。`replay` では `inputs` 必須。`record: true` で動画書き出し（第7.4章） |
| H→G | `start` | `{}` | ループ開始。この時点から `frame` が進む |
| H→G | `pause` / `resume` | `{}` | 画面外・バックグラウンド時に停止。`frame` も制限時間も進まない |
| G→H | `log` | `{from_frame, inputs: [[frame, kind, data], …]}` | 入力ログの逐次送信（64フレームごと） |
| G→H | `end` | `{result: "win"\|"lose", score?, frames, checkpoint?}` | 終了。1セッションに1回のみ。`time_limit` 到達時はSDKが `onTimeout` の戻り値で自動送信 |
| G→H | `media` | `{kind: "thumb"\|"video", blob}` | サムネイル（play の30フレーム目、PNG ≤ 64 KB）または書き出し動画（WebM ≤ 2 MB）。1セッションに各1回 |
| G→H | `error` | `{message}` | 例外。Hostは `lose` 扱いで次のゲームへ進む |
| H→G | `destroy` | `{}` | 破棄予告。Guestは音を止める。直後にiframe削除 |

`session_id` はHostが発行し、Guestは `end` にそれを添える。Hostは `init` 以降、`session_id` の一致しないメッセージをすべて捨てる。

### 6.2 SDK API（作者が使うもの）

```javascript
GF.onInit(({seed, mode, timeLimit}) => { /* 状態初期化。描画はまだしない */ });
GF.onStart(() => { /* 音の再生開始が許される最初の時点。ここから操作可能 */ });
GF.onTick((frame) => { /* 60Hz固定。ゲームロジックはここだけ */ });
GF.onDraw((alpha) => { /* 可変レート。描画のみ。状態を変えない */ });
GF.onInput((ev) => { /* {frame, kind:'tap'|'hold'|'swipe'|'tilt', data} */ });
GF.onTimeout(() => 'lose');   // 省略時は lose。'win' を返せば「時間切れまで耐えたら成功」
GF.win();            // 成功で終了。GF.end(1, {result:'win'}) と同じ
GF.lose();           // 失敗で終了。GF.end(0, {result:'lose'}) と同じ
GF.timeLeft;         // 残り論理フレーム数
GF.rng();            // seed 由来の決定論的乱数 [0,1)
GF.frame;            // 現在の論理フレーム番号
GF.end(score, {result, checkpoint});  // 終了報告。2回目以降は無視
GF.audio.gain;       // 0〜1。Host側の上限が掛かる
```

`onTick` と `onDraw` の分離が決定論性の核である。ロジックは固定60Hzで進み、描画は端末のリフレッシュレートに追従する。入力はSDKがDOMイベントを受け、次の `onTick` のフレーム番号を刻印してから `onInput` に渡すため、リプレイ時も同じフレームで同じ入力が再現される。

### 6.3 ミクロゲーム契約

投稿される1本は WarioWare 型のミクロゲームで、次の4点を満たす。静的解析（第4.4章）がメタ宣言の存在と範囲を検査し、Hostが実行時に制限時間を強制する。

| 項目 | 規約 | 宣言 |
| --- | --- | --- |
| 長さ | 180〜480 フレーム（3〜8秒）。既定 300 | `<meta name="gf:duration" content="300">` |
| 動詞 | 1〜8文字の命令形。幕間に表示する（「押せ！」「よけろ！」「合わせろ！」） | `<meta name="gf:verb" content="押せ！">` |
| 入力 | `tap` / `hold` / `swipe` / `tilt` のうち1種。幕間にアイコンで示す。MVPは `tilt` を受理しない | `<meta name="gf:input" content="tap">` |
| 結果 | `win` か `lose` を1回だけ報告。時間切れは `onTimeout` の戻り値（既定 `lose`） | コード |

ゲームは開始の瞬間から操作可能でなければならず（タイトル画面・説明文・カウントダウンを置かない）、`onStart` から 30 フレーム以内に入力を受け付ける。判定は `win` / `lose` の2値で、`score` は任意（持続時間や精度を記録したい場合のみ）。制限時間はHostが `init.time_limit` で渡し、SDKは `GF.frame` がそれに達した tick で `onTimeout` を呼び、その戻り値を `end` として送る。ゲームが先に `GF.win()` / `GF.lose()` を呼べばそこで終わる。

この型に合わないゲーム（長い・入力が複数・勝敗がない）は、`publish_game` が静的解析の段階で拒否し、修正方法をエラー文に含める（第9章）。

### 6.4 Host側の状態機械

HostはGuestごとに次の状態を持ち、状態に合わないメッセージは破棄する。形式検証（第13章）の対象はこの状態機械である。

[embedded content: Host側セッション状態機械 · 7状態]

`log`・`error`・`media` は RUNNING / PAUSED でのみ受理し、`end` は RUNNING と PAUSED で受理する（PAUSED での受理が必要な理由は第13章 P3）。Hostは `start` 送信時に壁時計の監視タイマー（`time_limit` ÷ 60 ＋ 1.5 秒、PAUSED 中は停止）を始め、満了までに `end` が届かなければ自ら ENDED(`lose`) へ遷移し、以後その session_id の `end` を捨てる。これが「結果は必ず1回、タイムアウトでも必ず終わる」を保証する唯一の経路で、Guestの自動 `end` は高速化のための補助に過ぎない。ENDED からは `init` で INITED に戻れるが、ラン中はHostが次のゲームへ進むので同じiframeを再利用しない（第8章）。作者の試遊ページとラン結果画面の「もう一回」だけが同じiframeに `init(mode: play)` を送る。このとき古い session_id の `end` が遅れて届く可能性があり、それを捨てられることが第13章で検証する性質の1つである。

## 7. リプレイと決定論性

リプレイは「シード + 入力ログ」の2つで完全に再現できることを規約とし、動画はこれが成立しないゲームのためのフォールバックに留める。入力ログは1プレイあたり平均で数KBに収まり、動画の100分の1以下である。

### 7.1 入力ログ形式

```json
{
  "v": 1,
  "sdk": "1.0",
  "seed": 2891734521,
  "frames": 1830,
  "inputs": [
    [12, "tap", [0.51, 0.72]],
    [48, "swipe", [0.2, 0.5, 0.8, 0.5]],
    [120, "key", "ArrowLeft", 1],
    [138, "key", "ArrowLeft", 0]
  ],
  "score": 4200,
  "checkpoint": "a91f…"
}
```

座標は画面サイズに依存しない 0〜1 の正規化値で記録し、端末の解像度が違っても同じ入力になる。`tilt` は 20Hz にサンプリングして量子化する。`frames` は `end` 時点の論理フレーム数で、プレイ時間の根拠になる（60Hz固定なので 1830 frames = 30.5 秒）。

### 7.2 決定論性の要件

| 要素 | 規約 | SDKの実装 |
| --- | --- | --- |
| 乱数 | `GF.rng()` のみ。`Math.random` は実行時にシード付き実装へ差し替え（ライブラリ内部の呼び出しも同じ乱数列になる） | xoshiro128** をシードから初期化 |
| 時間 | 論理時間は `GF.frame` のみ。`Date`, `performance.now` はフレーム由来の時刻を返す実装へ差し替え | `onTick` を 60Hz 固定で呼ぶ。遅延時はキャッチアップ、最大 5 tick/描画 |
| 入力 | `GF.onInput` 経由。DOMイベントの直接購読は警告 | DOMイベントを次の tick のフレーム番号で刻印し、ログに追記 |
| 浮動小数 | `Math.sin` 等は環境差が出うる。乱用禁止ではなく、`checkpoint` で検出 | `GF.end` 時に作者が任意の状態ハッシュを渡せる |
| 描画 | `onDraw` は状態を変更してはならない | リプレイ検証時は `onDraw` を呼ばずに `onTick` のみ実行 |

### 7.3 リプレイの3つの用途

1. **Showcase**: ゲームの紹介用リプレイ。作者が投稿後に試遊ページで最初に遊んだプレイ（`win` でも `lose` でも）を自動的に採用し、作者は後から差し替えられる。ラン中には流さず、ラン結果画面とお題ページのサムネイルをタップしたときに `init(mode: replay)` → `start` で再生する。
2. **タップで即プレイ**: 再生中のGuestをそのまま `init(mode: play)` で再初期化する。iframeのロードが済んでいるので遷移は1フレーム以内。
3. **スコア検証**: サーバが headless Chromium で同じHTMLと同じログを `onDraw` なしで高速実行し、`score` と `checkpoint` を照合する。ランキング上位と通報されたスコアに限定して実行する。

### 7.4 リプレイ動画の書き出し

共有用の動画は、Hostが `init(mode: replay, record: true)` → `start` でリプレイを走らせ、Guest側のSDKが自分の canvas を `captureStream()` ＋ `MediaRecorder` で録画して `media{kind: "video"}` で返す（親フレームからは別オリジンの iframe を録画できないため）。形式は WebM、縦 720×1280、長さはゲームの `duration` ＋結果表示 0.5 秒、上限 2 MB。Hostは受け取った動画を Web Share API（ファイル付き）でストーリーズやXに渡し、サーバには保存しない。ランまるごとの連結動画はクライアントでの結合が重いので Phase 2 とする。非決定的なゲーム（`gf:deterministic=false`）はリプレイが崩れるため、この書き出しを提供せず、スコアも `flagged` 扱いとする。

## 8. フィード体験とiframeライフサイクル

フィードの単位は「ラン」である。ランはお題1つに属するミクロゲームを決まった順で連続して遊ぶ体験で、既定は10本、幕間を挟んで自動で進み、途中で戻らない。Hostは常に最大3枚のiframe（N, N+1, N+2）だけを生かし、現在の1枚以外は `init` 済みで `start` 前の INITED 状態に止める。これにより、幕間からゲーム開始までの遅延はネットワークに依存せず、同時に実行中のゲームは常に1つに限られる。

### 8.1 スロットと状態の対応

| スロット | iframe | セッション状態 | 許されること |
| --- | --- | --- | --- |
| N−1 以前 / N+3 以降 | 存在しない（`destroy` 済み） | DESTROYED | なし |
| N+1, N+2 | ロード済み、不可視、`init(mode: play)` 済み | INITED | なし。`start` は送らない |
| N（幕間） | ロード済み、Hostの幕間レイヤの下 | INITED | 幕間レイヤに動詞と入力アイコンを 1.0 秒表示 |
| N（プレイ中） | 可視、ユーザー操作中 | RUNNING（play） | 入力・音声・`end`・`media` 受理 |
| N（結果） | 可視、Hostの結果フラッシュの下 | ENDED | ○/× を 0.5 秒表示して次へ。再挑戦はしない |

N+2 まで先読みするのは、5秒ごとに来る切替で空白を見せないためである。ランは戻れないので N−1 は持たない。モバイルのメモリ上限を考慮し、3枚を超えて生かすことはしない。

### 8.2 ゲーム間の遷移手順

1. N の `end`（またはHostの監視タイマー満了）で N が ENDED になる。結果フラッシュ（○/×、0.5 秒）を出す。
2. 新しい N（旧 N+1）が INITED なら幕間レイヤを 1.0 秒出し、その終わりに `start` を送る。これが唯一の `start` 送信点で、他スロットへ `start` を送ることはない。まだ LOADING なら幕間を延長し、`ready` 到着 → `init` → `start` とする。延長は最大 3 秒で、超えたらそのゲームを `lose` 扱いで飛ばす。
3. 旧 N に `destroy` を送り、iframe を DOM から外す。
4. 新 N+2 の iframe を生成し、`ready` を待って `init(mode: play)` を送る。

PAUSED のスロットに `init` を送って再利用することは禁止する。戻る操作でPAUSEDに戻った場合は `resume` し、別の用途に使いたい場合は `destroy` して作り直す。この禁止は形式検証で見つかった競合（古い `paused` ACKによる誤再初期化で、プレイの `end` が失われる）への対策である（第13章 P4）。

手順 1 と 2 の順序が重要で、必ず「旧Nが終わってから新Nを動かす」。第13章で「RUNNING（play）のGuestが同時に2つ存在しない」ことをこの手順に対して検証する。`pause` / `resume` はアプリがバックグラウンドに回ったときだけ使い、復帰時は幕間を出し直してから `resume` する。

### 8.3 幕間と即スタート

幕間はHostが iframe の上に描く不透明レイヤで、次のゲームの動詞（「押せ！」）と入力アイコンを大きく出す。幕間の終わりに `start` を送ると同時にレイヤを外すので、ゲームは最初のフレームから操作可能でなければならない（第6.3章）。ランの先頭でも同じ幕間を使い、「タップしてスタート」はランの開始時に1回だけ出す（iOS Safari の音声有効化のため）。

シードは play のたびにサーバが発行し、`session_id` と対で記録する。同じシードで複数回遊べないため、リプレイログを別セッションに使い回すことができない。

### 8.4 結果オーバーレイ

各ゲームの結果はフラッシュ（○/×、0.5 秒）だけで、ランの最後にHostが描くラン結果画面にまとめる。内容はクリア数 / 総数、自己ベスト、共有（リプレイ動画の書き出し、第7.4章）、各ゲームの一覧（作者、いいね、通報、Showcase 再生）、「もう一回」「次のお題へ」。この層がHostの描画であることを、画面上端の固定ヘッダーと合わせて視覚的に一貫させ、ゲーム内に描かれた偽UIと区別できるようにする。

### 8.5 資源制御

- 不可視スロットには `start` を送らないため、CPUを使うのは常に1枚
- 先読みスロット（N+1, N+2）はコードと `required` アセット（上限 512 KB）までしかロードしない。残りは表示中スロットになってから `GF.assets.load()` で取得し、BGMは `start`（play）後に読む。先読みの通信量は最大でも 2 × 640 KB 程度に収まる
- Hostは `PerformanceObserver` の long task を監視し、N のフレームが 500ms 以上ブロックされたら `destroy` して「このゲームは重すぎます」を表示
- iframe生成は `IntersectionObserver` ではなくスワイプ確定イベントで行い、スクロール中の無駄なロードを避ける
- 音声は `start`（play）後にのみ有効化し、初回訪問時はミュート。Hostの音量スライダーが `audio.gain` の上限になる

## 9. 投稿・リミックス MCPツール仕様

MCPサーバーは5つのツールだけを公開し、コードとアセット参照の受け渡しと系譜の記録を担う。アセットの実体（バイナリ）はMCPを通らない。ツールの説明文（AIが読む部分）に規約とライセンス条件を書き、AIがユーザーに確認したうえで投稿する流れにする。

### 9.1 ツール一覧

| ツール | 入力 | 出力 | 備考 |
| --- | --- | --- | --- |
| `publish_game` | `html`, `title`, `prompt`, `assets?: [{name, hash, required?}]`, `parent_id?`, `fork_token?` | `post_id`, `url`, `warnings[]`, `missing_assets[]` | 静的解析の拒否は error、警告は `warnings`。ハッシュが未知なら `missing_assets` に返し、投稿は `pending` のままブラウザでのアップロードを待つ |
| `fork_game` | `post_id` | `html`, `title`, `prompt`, `assets: [{name, hash, type, size}]`, `sdk_docs`, `lineage[]`, `fork_token` | 改造元のコードとアセット一覧をAIのコンテキストへ渡す。アセットはハッシュ参照で再利用できる |
| `search_assets` | `query`, `type?` | `[{hash, name, type, size, license, preview_url}]` | プラットフォーム提供の CC0 ライブラリを検索。AIが「ジャンプ音」「8bit風BGM」を探して `publish_game` の `assets` に入れる |
| `get_game` | `post_id` | メタデータ、スコア統計、派生数 | コードは含まない（閲覧用） |
| `my_games` | なし | 自分の投稿一覧と状態 | 状態 `restricted` の理由、`missing_assets` を含む |

MVPで公開するのは `publish_game`・`list_my_games`・`unpublish_game` の3つと、ミクロゲーム契約（第6.3章）とテンプレートを返すリソース `gf://guide` だけで、`fork_game`・`get_game`・`search_assets` は Phase 2 に回す。`publish_game` は `theme_id`（省略時はお題「フリー」）を追加で受け取り、`verb`・`input`・`duration` は HTML の `<meta name="gf:*">` から読む。MCPクライアントは Muse と Claude のカスタムコネクタを一次対象とし、認証は OAuth 2.1（DCR・PKCE）で、サーバはアプリ本体と同居する（計画書 第5節）。Muse のカスタムコネクタはツール単位の許可を持たないため、取り消せない操作（削除）はツールに含めない。

アセットの実体は3経路でしか入らない。(a) `search_assets` で見つかるライブラリ、(b) `fork_game` 元の投稿が持つもの、(c) 作者がブラウザのアップロードUI（Showcase 録画と同じ画面）で入れたもの。`publish_game` が受け取るのはいずれもハッシュであり、(c) の場合は先にアップロードしてハッシュを得るか、投稿後に `missing_assets` を埋める。AIが音声や3Dモデルを生成できない以上、この分離は制約ではなく現実に合わせた設計である。

`fork_game` の出力は `publish_game` に戻すまで有効な `fork_token` を含み、`publish_game` はこれを受け取ったときだけ `parent_id` を信用する。トークンなしで任意の `parent_id` を名乗ることはできない。

### 9.2 publish_game の処理順

1. OAuthトークンからユーザーを特定し、投稿レート制限を確認する（新規アカウント: 5件/日、通常: 30件/日）
2. サイズ・単一ファイル・読み込み先・禁止識別子の静的解析（第4.1章）。違反は即 error
3. `assets` の各ハッシュが、ライブラリ／本人のアップロード済み／`fork_token` が指す親投稿のもの、のいずれかであることを確認し、種別ごとの上限と合計 3 MB、`required` 合計 512 KB を検査。未知のハッシュは `missing_assets` へ
4. `fork_token` があれば検証して `parent_id` を確定し、親の `tree_id` を継承。なければ新規 `tree_id`
5. HTMLをコンテンツハッシュ名でS3に保存（同一ハッシュは重複排除）。`post_assets` 行を作成
6. `posts` 行を `base_status = pending` で作成し、`post_id` を返す
7. 作者がブラウザで不足アセットをアップロードし、Showcase を録る（`url` を開くと録画UIになる）。両方そろって `public`、新規アカウントは `limited`

`showcase` 引数は廃止し、投稿後に作者が試遊ページで最初に遊んだプレイを Showcase とサムネイルに自動採用する（第7.3章、第6.1章 `media`）。試遊前の投稿も Showcase なしで `public` になれるが、お題ページのサムネイルは「？」で表示し、誰かが1回遊んだ時点で埋まる。`expired` 状態はMVPでは使わない。AIから直接投稿する場合、`publish_game` の応答に試遊URLを含め、作者に開いてもらう。

### 9.3 リミックス導線

結果オーバーレイの「リミックス」ボタンは、次の1文をクリップボードにコピーする。

```text
GameFeed のゲーム gf:01HX7… をリミックスしたい。fork_game で取得して、
[ここに変更内容] を加えて publish_game で投稿して。
```

`gf:` 接頭辞付きIDがツール説明文に登場するため、AIは `fork_game` を呼ぶべきだと判断できる。MCP未接続のAIに貼った場合は、ゲームページのURLと接続手順が続けて表示される。

### 9.4 ライセンス

全投稿は投稿時点で「GameFeed上でのリミックスを無条件に許諾する」ことに同意したものとする。CC BY 4.0 相当で、派生作品は元作者の表示（系譜表示）を義務とする。元投稿が削除されても派生は残り、系譜表示は「削除済みの投稿」になる。これはScratchの運用に倣う。

## 10. スコアとランキング

スコアはGuestの「主張」であり、サーバは3段階で妥当性を判定する。ランキング表示は仮確定と本確定の2層に分け、ユーザーには即時に仮順位を見せつつ、検証後に確定させる。

### 10.1 提出プロトコル

1. Hostはplay開始時にAPIへ `POST /sessions` を送り、`{session_id, seed}` を得る。`init` にこれを使う
2. Guestの `log` をHostが集約し、`end` 受信時に `PUT /sessions/{id}/result` で `{score, frames, inputs, checkpoint}` を1回だけ送る
3. APIはセッションが `open` 状態であることを確認して `submitted` に変え、同じ `session_id` への2回目以降は `409` を返す（冪等性）
4. 第1段階（同期、即時）: 範囲検査。`frames` がサーバ側経過時間 × 60 × 1.05 以下か、`score` がその投稿の既存上位スコア分布から外れすぎていないか（中央値の 20倍超は保留）
5. 第2段階（非同期、数秒）: 投稿内上位10位以内、または第1段階で保留になったものを headless 再実行で検証。`score` と `checkpoint` が一致すれば `accepted`、不一致は `rejected`
6. 第3段階（非同期、日次）: 総合ランキング上位100位を再検証し、同一ユーザーの異常パターン（全投稿で1位など）をフラグ

### 10.2 Verdict と表示

| Verdict | 条件 | 投稿内ランキング | 総合ランキング |
| --- | --- | --- | --- |
| `provisional` | 第1段階通過、第2段階待ち | 仮順位として表示 | 非表示 |
| `accepted` | 再実行で一致 | 確定表示 | 表示 |
| `rejected` | 再実行で不一致、または範囲外 | 非表示。本人には「検証できませんでした」 | 非表示 |
| `flagged` | 非決定論ゲーム、または第3段階の異常 | 表示（検証不能マーク） | 非表示 |

`rejected` が同一ユーザーで月3回を超えると、そのユーザーの全スコアを `provisional` 止まりにする（自動制限）。偽陽性の救済として本人が再検証を1回要求できる。

### 10.3 ランキングの種類

- 投稿内ランキング: その投稿の全セッションからユーザーごとの最高スコア。Redis sorted set、`accepted` と `provisional` を別キーで持ち、表示時にマージ
- 総合ランキング: 週次。各投稿で上位10%に入った回数を集計。スコアの絶対値はゲームごとに尺度が違うため使わない
- リミックスツリー内ランキング: 派生ゲーム群を横断した「どの派生が最も遊ばれたか」。作者向けの指標

### 10.4 スコアの単調性

ゲームがスコアを時間とともに減らすことは許されるが、`end` で報告する `score` は整数かつ `0 ≤ score ≤ 2^31−1` とし、SDKがクランプする。負のスコアや小数のゲームは作者が正規化する。

## 11. モデレーションと状態遷移

モデレーションは「投稿状態」「通報」「アカウント信頼」の3つのデータで構成し、MVP時点ではすべての遷移があるが、自動判定の閾値を緩くして人の審査に寄せる。規模拡大時は閾値と分類器を変えるだけで、スキーマと遷移は変えない。

### 11.1 投稿状態機械

[embedded content: 投稿状態機械 · 6状態]

`restricted` から `public` への復帰はモデレーターの明示操作に限り、自動判定では決して戻らない。`removed` と `expired` は終端状態で、派生の系譜表示に「削除済み」として残る。`limited` も通報等で `restricted` に落ちる（図の下段からの矢印）。

### 11.2 通報

| 項目 | 仕様 |
| --- | --- |
| カテゴリ | 性的 / 暴力 / 差別 / 著作権 / 光過敏 / 音量 / スパム / 動作しない / その他 |
| 重み | 通報者の信頼スコア × カテゴリ係数（性的・光過敏は 3、動作しないは 0.2） |
| 自動制限 | 重み合計が 10 を超えたら `restricted`。性的・光過敏は単独で 5 |
| 抑止 | 同一ユーザーは同一投稿に1回。通報が却下され続けると通報者の重みが下がる |
| キュー | 重み順。モデレーターはサムネイル・Showcase・通報カテゴリを一覧で見て判断 |

### 11.3 アカウント信頼と処分

信頼スコアは 0〜100 で、新規は 10。公開投稿が通報なしで7日経過すると +5、`restricted` で −20、`removed`（モデレーター判断）で −50。30 未満のアカウントの新規投稿は `limited` から始まり、30 以上で `public` から始まる。

処分は「投稿制限（新規投稿不可）」「BAN（全投稿 `removed`、ログイン不可）」の2種類。BANは全投稿を同一トランザクションで `removed` にする。「BANされたアカウントの投稿がフィードに残らない」ことは第13章で検証する。

### 11.4 ツリー一括制限

モデレーターは投稿単位のほか「この投稿とその全派生」を `restricted` にできる。対象は `parent_id` を辿った子孫全体で、同じ `tree_id` を持つ投稿すべてではない（兄弟は巷き込まない）。一括制限は `moderation_actions` に1行として記録し、復帰も同じ単位で行える。ただし復帰時は、一括制限より後に個別に `restricted` された投稿を復帰させてはならない。この条件は形式検証で最初のモデルが違反した点である（第13章）。

## 12. データモデル

Postgres に7テーブル、Redis にランキング、S3 にゲーム本体とリプレイを置く。不変条件はDB制約で表せるものはすべて制約にし、表せないもの（ツリー整合、BAN時の全投稿非公開）はトランザクション境界と第13章の検証で担保する。

### 12.1 テーブル

| テーブル | 主なカラム | 制約・索引 |
| --- | --- | --- |
| `users` | `id`, `handle`, `trust_score int`, `status enum(active, post_restricted, banned)`, `created_at` | `handle` unique |
| `games` | `hash pk`, `size`, `s3_key`, `analysis jsonb`, `created_at` | HTMLはハッシュで重複排除。不変 |
| `posts` | `id pk`, `user_id`, `game_hash`, `title`, `prompt`, `controls`, `deterministic bool`, `parent_id null`, `tree_id`, `depth`, `base_status enum(pending, limited, public, removed, expired)`, `indiv_restricted bool`, `showcase_key null`, `created_at`。表示用の `status` は `base_status`・`indiv_restricted`・`tree_locks` から導出するビュー（`restricted` は導出値） | `(tree_id, depth)`, `(user_id, status)`, `(status, created_at)`。`parent_id` は `posts.id` 外部キー、削除は `RESTRICT` |
| `sessions` | `id pk`, `post_id`, `user_id null`, `seed`, `mode`, `state enum(open, submitted, abandoned)`, `score`, `frames`, `log_key`, `checkpoint`, `verdict enum(provisional, accepted, rejected, flagged)`, `opened_at`, `submitted_at` | `(post_id, user_id, verdict, score desc)`。`submitted_at` は `state=submitted` のとき非NULL（CHECK） |
| `reports` | `id`, `post_id`, `reporter_id`, `category`, `weight`, `resolution enum(open, upheld, dismissed)`, `created_at` | `(post_id, reporter_id)` unique |
| `moderation_actions` | `id`, `actor_id`, `kind enum(restrict, restore, remove, restrict_tree, restore_tree, ban_user)`, `post_id null`, `user_id null`, `reason`, `created_at` | 追記のみ。全状態変更の監査ログ |
| `fork_tokens` | `token pk`, `post_id`, `user_id`, `expires_at`, `used_at null` | 24時間で失効。1回限り |
| `tree_locks` | `root_post_id pk`, `action_id`, `created_at` | 有効なツリー制限の根。投稿 p が制限中 ⇔ p の祖先（p 自身含む）に root_post_id がある。復帰は行の削除 |
| `assets` | `hash pk`, `type enum(image, sfx, bgm, model, font)`, `size`, `s3_key`, `source enum(library, user)`, `uploader_id null`, `scan jsonb`, `created_at` | 不変。正規化後（WebP / Opus / GLB）のバイト列のハッシュ。`scan` に画像分類・輝度変化検知の結果を持ち、審査ワーカーはここを見る |
| `post_assets` | `post_id`, `name`, `asset_hash`, `required bool` | `(post_id, name)` unique。配信時に `./assets/<name>` → S3 のハッシュ名へ解決する |

### 12.2 不変条件

| ID | 条件 | 担保手段 |
| --- | --- | --- |
| I1 | `parent_id` を辿ると必ず `parent_id IS NULL` の根に到達する（閉路なし） | 新規投稿は常に `parent_id` 確定後に挿入され、既存行の `parent_id` は更新不可（トリガーで拒否）。形式検証 P5 |
| I2 | 子の `tree_id` と `depth` は親から導かれる（`tree_id` 一致、`depth = 親 + 1`） | 挿入時に親行を `FOR SHARE` ロックして計算 |
| I3 | `users.status = banned` のユーザーの投稿はすべて `removed` | BAN と全投稿更新（終端状態を除く）を1トランザクション。投稿挿入時は users 行を FOR SHARE でロックして status を再確認。形式検証 P6 |
| I4 | `status IN (limited, public)` なら `showcase_key IS NOT NULL` | CHECK 制約 |
| I5 | `removed`, `expired` からの遷移は存在しない | トリガーで拒否。形式検証 P7 |
| I6 | `restricted → public/limited` は `moderation_actions.kind = restore/restore_tree` を伴う | 同一トランザクションで監査行を挿入。形式検証 P8 |
| I7 | 1セッションの `submitted` 遷移は高々1回 | `UPDATE … WHERE state = 'open'` の更新行数で判定。形式検証 P3 |
| I8 | `sessions.verdict = accepted` なら `score` と `checkpoint` が再実行結果と一致している | 検証ワーカーのみが `accepted` を書ける（DBロール分離） |
| I9 | 投稿の `post_assets` は合計 3 MB・32 件以下、`required` 合計 512 KB 以下、BGM は `required` 不可 | `publish_game` と不足アセットのアップロード完了時に同一トランザクションで集計して検査。`public` / `limited` への遷移条件に含める |

### 12.3 Redis / S3

- `rank:{post_id}:accepted`, `rank:{post_id}:provisional`: sorted set、member は `user_id`、score は最高スコア
- `rank:weekly:{iso_week}`: 総合。上位10%入賞回数
- S3 `games/{hash}.html`（不変、CDNキャッシュ1年）、`assets/{hash}.{webp|ogg|glb|woff2}`（不変、全投稿で共有）、`lib/{name}@{version}.min.js`（ホワイトリスト）、`replays/{session_id}.json.gz`、`showcase/{post_id}.json.gz` または `.webm`、`thumbs/{post_id}.webp`
- 配信 Worker は `<games-origin>/p/<post_id>/assets/<name>` を `post_assets` 経由でハッシュ名へリライトし、`Cache-Control: immutable` を付ける

### 12.4 ミクロゲーム対応の追加分

| テーブル・列 | 内容 |
| --- | --- |
| `themes` | お題。`id`, `title`, `prompt`（作り手向けの説明）, `status`（draft / open / closed）, `opens_at`, `closes_at`, `created_by`。MVPでは運営だけが作る |
| `games.theme_id` | 所属するお題。NULL は「フリー」 |
| `games.verb`, `games.input`, `games.duration_frames` | メタ宣言から静的解析が写す。`duration_frames` は 180〜480 |
| `games.thumb_key` | サムネイルの保存キー。最初の `media{kind: thumb}` で埋まる |
| `runs` | ラン。`id`, `user_id`（匿名可）, `theme_id`, `seed`, `game_ids[]`, `results[]`（win / lose）, `cleared`, `total`, `started_at`, `ended_at` |
| `run_results`（ビュー） | お題ごとのクリア率・完走率。第14章の計測に使う |

追加の不変条件：`runs.cleared ≤ runs.total`、`results` の長さは常に `total` 以下、`games.duration_frames ∈ [180, 480]`、`public` な `games` は `verb`・`input` が非NULL。ランのシードは `theme_id` と日付から決め、同じ日の同じお題は同じ順序になる（共有したランを相手が同じ順で遊べる）。

## 13. 形式的検証

本仕様のうち並行性が絡む3箇所を TLA+ でモデル化し、TLC（tla2tools 1.8.0）で有限境界の全状態を網羅検査した。合計15の性質を検査し、素朴な設計に対して**6つの設計欠陥**が反例として見つかった。欠陥はすべて仕様に反映済みで、修正後の設計では全性質が成立する。モデルの TLA+ ソースは別添の `Session.tla`, `Feed.tla`, `Moderation.tla`。

### 13.1 検証対象の選定

| モデル | 対象 | 選んだ理由 | 範囲外としたもの |
| --- | --- | --- | --- |
| A: Session | Host と Guest の postMessage プロトコル（第6章） | 非同期FIFOチャネル越しの状態機械で、遅延メッセージの取り違えが起きやすい | SDK内部のフレーム処理、`log` の内容 |
| B: Feed | 4枚ウィンドウとスワイプ手順（第8章） | 「同時に動くゲームは1つ」をUIの手順に対して確認したい | ネットワーク遅延の数値、描画 |
| C: Moderation | 投稿状態・系譜・ツリー制限・BAN（第11〜12章） | 複数行をまたぐ状態変更で、トランザクション境界の誤りが起きやすい | 通報の重み計算、信頼スコアの数値 |

サンドボックス（第5章）はブラウザ実装への依存であり、モデル検査の対象にはならない。こちらは実機での侵入テスト項目として第15章に挙げる。

### 13.2 モデルA: セッションプロトコル

Host と Guest を別プロセスとし、双方向の FIFO チャネルでメッセージを運ぶ。設計上の選択肢を3つの定数にし、組み合わせごとに検査した。境界は session_id 5 個まで、チャネル長 4 まで。

| 性質 | 内容 |
| --- | --- |
| P1 | 1つの session_id につき受理される結果は高々1つ |
| P2 | 受理した結果の session_id と mode は Host の現在セッションと一致する（リプレイをスコアにしない） |
| P3 | 現在セッションの `end` を Host が捨てることはない |
| P4 | Guest が終了させたプレイセッションの `end` は、iframe 破棄以外で失われない |

| 設計 | session_id 照合 | `end` を PAUSED で受理 | PAUSED から `init` | 結果 |
| --- | --- | --- | --- | --- |
| 素朴1 | なし | する | しない | **P2 違反**（11手） |
| 素朴2 | する | しない | しない | **P3 違反**（10手） |
| 素朴3 | する | する | ACK待ちで可 | **P4 違反**（16手） |
| 採用 | する | する | 禁止 | 全性質成立。129,335 状態 |

反例1（P2）: Showcase 再生中に Guest が `end(sid=1, replay)` を送った直後、ユーザーのタップで Host が `init(sid=2, play)` → `start` を送る。遅れて届いた sid=1 の `end` を、照合なしの Host はプレイ中のスコアとして受理する。対策: `session_id` の照合（第6.1章）。

反例2（P3）: プレイ中に Host が `pause` を送るのと同時に Guest が `end` を送る。Host は PAUSED で `end` を受け取るが、RUNNING 限定の受理条件により捨ててしまい、正当なスコアが消える。対策: `end` は PAUSED でも受理する（第6.3章）。当初の第8.2章「pause して3秒待つ」はこの競合を時間で誤魔化していた。

反例3（P4）: pause → resume → pause と続けた後、1回目の pause に対する古い `paused` ACK が届く。Host はそれを2回目の ACK と誤認して `init` を送り、resume 後に Guest が送った `end` が旧 session_id として捨てられる。対策: PAUSED からの `init` を禁止し、ACK 自体を廃止（第8.2章）。

### 13.3 モデルB: フィードウィンドウ

7件の投稿、ウィンドウ N−1〜N+2、スワイプ・タップ・終了・非同期 `ready` を含む 3,237 状態を検査した。

| 性質 | 内容 | 結果 |
| --- | --- | --- |
| F1 | 同時に RUNNING の iframe は高々1つ | 成立 |
| F2 | RUNNING の iframe は常に表示中スロット | 成立 |
| F3 | 生きている iframe の集合は常に N−1〜N+2 と一致 | 成立 |
| F4 | iframe は4枚以下 | 成立 |
| F5 | 表示中スロットが LOADING になることはない | **不成立**（2手: 先読み完了前にスワイプ） |

F5 の不成立は設計上の限界であって欠陥ではない。「即遊べる」は N+2 までの先読みで確率を下げるものであり、保証はできない。LOADING を表示した回数は計測指標にする（第14章）。

### 13.4 モデルC: 投稿状態・系譜・BAN

最大2ユーザー・投稿3件の範囲で、fork・Showcase・期限切れ・通報制限・個別復帰・削除・ツリー制限・ツリー復帰・BAN・作者削除を含む。設計の選択肢は「status 列1本（素朴）」対「基本状態＋制限理由から可視性を導出」、および「投稿の挿入時にユーザー状態を再確認するか」。

| 性質 | 内容 |
| --- | --- |
| P5 | 系譜に閉路がない（親IDは常に自分より小さい） |
| P6 | BAN されたユーザーの投稿はすべて終端状態（removed / expired） |
| P7 | removed / expired から出る遷移がない |
| P9 | 個別に制限された投稿は、個別に復帰されるまで可視にならない |
| P10 | ツリー制限が有効な間、その子孫に可視の投稿がない |
| P11 | 親の削除で子の行が消えない（系譜表示が壊れない） |

| 設計 | status 列 | 挿入時再確認 | 結果 |
| --- | --- | --- | --- |
| 素朴 | 1本 | なし | **P6 違反**（4手） |
| 素朴＋再確認 | 1本 | あり | **P10 違反**（5手）、**P9 違反**（8手） |
| 採用 | 導出 | あり | 全性質成立。2ユーザー・投稿2件で 61,650 状態、1ユーザー・投稿3件で 20,640 状態を網羅 |

反例4（P6）: `publish_game` がユーザー状態 `active` を確認した後、行を挿入する前に BAN が走る。BAN は既存投稿だけを `removed` にするため、直後に挿入された投稿が残る。対策: 挿入トランザクション内で `users` 行を `FOR SHARE` ロックして再確認する（第12.2章 I3）。

反例5（P10）: ツリー制限時に `pending` だった投稿が、その後の Showcase 録画で `public` になる。status 列1本の設計では「ツリーが制限中」という事実がどこにも残っていないため防げない。対策: 可視性を `base` と制限理由（個別 / ツリー根の集合）から導出する。

反例6（P9）: ツリー制限中に個別制限も受けた投稿が、ツリー復帰で `prev` に戻されて可視になる。対策: 同上。ツリー復帰は「ツリー根の集合から根を外す」だけで、個別制限の理由は残る。

検査の過程でモデル自身の記述ミスも2件見つかった（BAN が expired の投稿を removed に書き換えて P7 に違反、演算子の結合順）。前者は実装でも起こりうる誤りで、BAN の一括更新は `WHERE status NOT IN ('removed','expired')` とする。

### 13.5 仕様への反映一覧

| 反例 | 変更した箇所 |
| --- | --- |
| 1 | 第6.1章: `session_id` 照合を必須に |
| 2 | 第6.3章・第8.2章: `end` を PAUSED でも受理。「3秒待つ」を削除 |
| 3 | 第8.2章: PAUSED からの `init` 禁止。`paused` ACK 廃止 |
| 4 | 第12.2章 I3: 挿入時に `users` を `FOR SHARE` で再確認 |
| 5, 6 | 第11.4章・第12.1章: `status` を導出値に。`indiv_restricted bool` と `tree_locks` テーブルを追加 |
| P7 | 第11.3章: BAN の一括更新は終端状態を除外 |

### 13.6 限界

- 有限境界での検査であり、session_id 6 個以上、投稿 4 件以上で初めて現れるバグは原理的に見つけられない。ただし本モデルの性質は構造的で、境界を広げても新しいパターンは出にくい
- モデルと実装は別物である。実装側では、TLC の反例トレースをそのまま結合テストのシナリオにすること（6本）、および P1〜P4 を Host 実装の実行時アサーションとして残すことを推奨する
- 活性（「いつかは終わる」）は検査していない。ユーザーが遊び続ける限りセッションは終わらないため、活性は要件ではない

### 13.7 ミクロゲーム拡張（再検証は W2）

ミクロゲームへの転換で、モデルAとBに次の変更が要る。第11章の投稿状態機械（モデルC）は変わらない。

| モデル | 変更 | 追加で検証する性質 |
| --- | --- | --- |
| A: セッション | Hostに壁時計の監視タイマーを追加し、満了で RUNNING / PAUSED → ENDED(lose)。`end` は RUNNING / PAUSED かつタイマー未満了のときだけ受理 | P11: 全セッションは有限ステップで ENDED か DESTROYED に至る（Guestが `end` を送らなくても）。P12: 結果（win / lose）は1セッションに正確に1回だけ記録される |
| A: セッション | `media` メッセージを追加（RUNNING / PAUSED で受理、kind ごとに1回） | P13: サムネイルは1セッションに高々1回しか保存されない |
| B: フィード | 戻る操作を削除、スロットを3枚（N, N+1, N+2）に、遷移の契機をスワイプから `end` / タイマー満了に変更、幕間の延長上限（LOADING のまま 3 秒で `lose` 扱いで飛ばす）を追加 | F1〜F5 を新しい遷移手順に対して再検査。F6: ランは必ず `total` 本以内で終わる |

再検証は SDK（計画書 #3）の着手前に TLC で実行し、結果と反例をこの節に追記する。それまで本節の性質は「未検証」として扱う。

## 14. 段階的ロードマップ

MVP（Phase 1）は「フィードで次々に遊べる」体験を検証することだけに絞り、ランキングとリミックスは Phase 2 に回す。ただし第12章のスキーマ（状態、通報、系譜、セッション）は Phase 0 で全部作る。後から足すのは機能であってテーブルではない。

2026-11-03 改訂：Phase 1 の体験を「縦スワイプで1本ずつ遊ぶ」から「お題のランでミクロゲームを連続で遊ぶ」に変更した。ゲートの内容（投稿100件・通報運用開始）は変えない。週次の計画は計画書を正とする。

[embedded content: ロードマップ · 4フェーズと3ゲート]

フェーズの境界は日付ではなくゲート条件で決める。Phase 1 の審査は運営者がサムネイル一覧で全件目視する前提で、新規アカウントは5件/日の投稿上限をかける。Phase 1 から計測する指標は次の4つ。

- Showcase 開始までの遅延（スワイプ確定から最初のフレームまで）と、表示中スロットが LOADING だった割合（第13.3章 F5）
- タップ率（Showcase を見たうち実際に遊んだ割合）と、完走率（`end` まで到達した割合）
- 投稿あたりの通報数と、通報から非公開までの時間
- 投稿のうち静的解析で拒否された割合と、その理由の内訳（SDK規約のAI側の守られ方を知る）

## 15. 未解決事項とリスク

形式検証の対象外で、実機テストか運用で確かめるしかない事項を挙げる。上から順に、MVP 前に潰す必要があるもの。

| # | 事項 | 現時点の判断 | 確認方法 |
| --- | --- | --- | --- |
| 1 | サンドボックス突破 | 別オリジン（Host と別サイト）+ `allow-scripts` のみ + CSP（`sandbox` を含む）の3層で十分と判断。投稿間の隔離はパス分け（2026-11-03 改訂） | Phase 0 のゲートとして第三者の侵入テスト。特に `allow-same-origin` なしでの `document.domain`、`blob:` URL 経由のナビゲーション、Service Worker 登録、ゲームURLの直接オープン時の `sandbox` 適用、他投稿のパス（`/p/<other>/`）の読み込みを試す。ここで隔離が不十分と分かれば投稿ごとのサブドメイン方式へ戻す |
| 2 | `credentialless` 未対応ブラウザ | 配信オリジンが Cookie を一切発行しないため必須ではない | Safari・Firefox で、ゲームから Cookie・ストレージが使えないことを手動確認 |
| 3 | 決定論性の破れ | `Math.sin` 等の環境差は `checkpoint` 不一致として `rejected` に落ちる | 主要端末 5 機種で同一ログの再実行一致率を計測。低ければ `flagged` の閾値を調整 |
| 4 | AI がSDK規約を守らない | ツール説明文に規約を書き、静的解析で拒否 | 静的解析の拒否率を計測（第14章）。高ければ `publish_game` にテンプレートHTMLを返す補助ツールを追加 |
| 5 | 再実行コスト | headless Chromium 1 本あたり数秒。上位10位＋保留分だけなら投稿 1 万件規模でも 1 ノードで足りる見込み | Phase 2 で実測。超えるなら `onDraw` なし実行の高速化か、サンプリング検証 |
| 6 | 偽UIによるフィッシング | iframe 外周に Host の枠を常時表示。入力フォームは `allow-forms` なしで不可 | 通報カテゴリ「なりすまし」を追加するか検討 |
| 7 | 著作権（既存ゲームのクローン、キャラクター画像） | 通報ベース。投稿時の画像分類は Phase 3 | 権利者向けの削除申請窓口を Phase 1 から用意 |
| 8 | リミックスの帰属と削除 | 元投稿削除後も派生は残る（第9.4章）。元作者が派生の削除を求めるケースは想定 | 利用規約で明示。異議申し立ては手動対応 |
| 9 | 投稿経路の限定 | MCP に絞るのはUXとスパム抑止のため。手動 `curl` は防げないし防がない | OAuth クライアント登録制にして、クライアントごとのレート制限を可能にしておく |
| 10 | 未成年ユーザー | ゲーム内容とコメントの両方でリスク | 年齢確認の方式は未決定。コメント機能は Phase 2 以降に回し、MVP ではいいねと通報のみ |
| 11 | アセット増によるフィードの通信量 | 先読みは required（512 KB）までに限定し、BGM と 3D モデルは表示後に遅延ロード | モバイル回線で 1 セッションあたりの転送量と Showcase 開始遅延を計測。超えるなら required 上限を 256 KB に下げるか、回線種別で先読み枚数を変える |

改訂で増えた未解決事項：(a) 幕間 1.0 秒・結果 0.5 秒のテンポが合うかは W3 に自分で、W7 に大学生のβで決める。(b) iOS Safari の sandbox iframe 内で `captureStream` ＋ `MediaRecorder` が動くかは W5 に実機で確認し、だめなら動画書き出しを Android 限定にする。(c) Muse のトークン更新で 401 が頻発する問題（計画書 第6節）。(d) 第13.7節の再検証。

### 別添

形式検証のモデル（`Session.tla`, `Feed.tla`, `Moderation.tla`）と TLC の設定ファイルは本仕様書と同時に提供する。再現手順は `java -cp tla2tools.jar tlc2.TLC -deadlock -config Session_D.cfg Session.tla`。
