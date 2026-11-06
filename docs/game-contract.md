# ゲーム規約（game-contract）

2026-11-06 作成。前提は `docs/product.md` 6（ゲームの型）と 9（作る側のループ）。

この文書は 2 部に分かれる。**A 部は規約の本文**で、作る側とその AI が読む。MCP の `gf://guide` リソースは A 部をそのまま返す。**B 部は解説**で、規則の理由と却下した案を置く。B 部は `gf://guide` に含めない。
節番号は `gc#A.3` のように参照する。

---

# A. 規約

## A.1 ゲームの型（最初に読む）

GameFeed のゲームは、幕間を挟んで連続で遊ばれる短いゲームである。次の 8 つを満たす。

1. **3〜10 秒で終わる**。長さは `gf:duration`（論理フレーム数、60 フレーム = 1 秒、180〜600）で宣言する。時間切れは必ず来る。早く終わってもよい
2. **操作は 1 種類**（tap / hold / swipe のどれか）。`gf:input` で宣言する。幕間でアイコンとして示される
3. **開始の瞬間から操作できる**。タイトル画面・説明・カウントダウンを置かない。遊ぶ側は幕間で `gf:verb`（動詞）を見てから入ってくる
4. **点数を報告する**。`GF.score` に現在の点を入れ続ける。整数で、大きいほど良い。勝敗が自然なゲームは 0 と 1 でよい
5. **目標点を宣言する**。`gf:target` に「上手い人がこれくらい取る」という点を書く
6. **1.5 倍速でも成立する**。ゲームは実時間より速く進められることがある。1 フレーム = 1/60 秒としてロジックを書けば、速度は SDK が吸収する。速くなっても解ける難しさにする
7. **決定論的に動く**。乱数は `GF.rng()`、時間は `GF.frame` だけを使う。同じシードと同じ入力で同じ結果になる
8. **外部と通信しない。保存しない**。ゲームは画面の中で完結する

## A.2 ファイルと上限

| 項目 | 規約 |
| --- | --- |
| ファイル | `index.html` 1 つ。`<script>` と `<style>` はインライン |
| サイズ | 128 KB 以下（gzip 前、UTF-8 バイト数） |
| 読み込み先 | `./assets/<name>`（A.6、Phase 2）と `/lib/<name>@<version>.min.js`（A.7）だけ。それ以外の `src` / `href` / `url()` / `@import` は不可。`data:` URI も不可 |
| 画面 | 縦長 9:16 を基準に `100vw × 100vh` に収める。`<meta name="viewport">` は SDK が注入するので書かない |
| 文字コード | UTF-8。`<meta charset="utf-8">` を書く |

## A.3 メタ宣言

`<head>` に次を書く。欠落・範囲外は投稿時に拒否される。

| タグ | 値 | 例 |
| --- | --- | --- |
| `<title>` | ゲーム名。空は不可 | `<title>まるタップ</title>` |
| `<meta name="gf:duration">` | 180〜600 の整数（論理フレーム。300 = 5 秒） | `content="300"` |
| `<meta name="gf:verb">` | 幕間に大きく出す命令形。1〜8 文字 | `content="タップ！"` |
| `<meta name="gf:input">` | `tap` / `hold` / `swipe` のどれか 1 つ。`tilt` は現在受け付けない | `content="tap"` |
| `<meta name="gf:target">` | 目標点。1 以上の整数 | `content="12"` |
| `<meta name="gf:deterministic">` | 省略可。物理エンジン等で環境差が出うるとき `false` | `content="false"` |

## A.4 SDK（`GF`）

SDK は配信時に `<head>` へ注入される。ゲームは `GF` グローバルだけを使う。読み込みや初期化のコードは書かない。

```javascript
GF.onInit(({ seed, mode }) => { /* 状態を初期化する。描画はまだしない */ });
GF.onStart(() => { /* 音を鳴らし始めてよい最初の時点 */ });
GF.onTick((frame) => { /* 60 Hz 固定。ゲームの進行はここだけで行う */ });
GF.onDraw((alpha) => { /* 描画だけ。状態を変えない。呼ばれる間隔は端末次第 */ });
GF.onInput((ev) => { /* ev = { frame, kind, data }。下の表を見る */ });

GF.rng();          // 0 以上 1 未満の決定論的な乱数
GF.frame;          // 現在の論理フレーム番号（0 から）
GF.timeLimit;      // 宣言した長さ（フレーム）
GF.timeLeft;       // 残りフレーム
GF.score;          // 現在の点。ゲームが書き換える。整数、0 以上
GF.end();          // 早く終える。省略可。時間切れは SDK が GF.score で終える
GF.audio.gain;     // 0〜1。Host 側の上限が掛かる
```

入力イベントの `data`。座標は画面に対する 0〜1 の正規化値で、端末の解像度に依存しない。

| `kind` | `data` | いつ |
| --- | --- | --- |
| `tap` | `[x, y]` | 押して離したとき |
| `hold` | `[x, y, 1]` / `[x, y, 0]` | 押した瞬間（1）と離した瞬間（0） |
| `swipe` | `[x0, y0, x1, y1]` | 始点と終点。離した瞬間 |

規則:

- 状態の更新は `onTick` だけで行う。`onDraw` と `onInput` では状態を変えない（`onInput` は入力を変数に記録し、次の `onTick` で処理する。簡単なゲームでは `onInput` で直接点を足してもよいが、描画は変えない）
- `GF.score` は `onInit` で 0 にする。負にしない。小数にしない。上限は 2,147,483,647
- `GF.end()` は 1 回だけ効く。2 回目以降は無視される
- `onTick` は 1 回で 1 フレーム進める。重い計算を 1 フレームに集めない（1.5 倍速で 2 倍の頻度で呼ばれる）
- `onDraw` は呼ばれないことがある（検証時）。描画がなくてもゲームが進むように書く

## A.5 使えない API

次は投稿時に拒否される。実行時にも SDK が差し替えているので、回避しても動かない。

| 使えないもの | 代わりに |
| --- | --- |
| `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` | ゲームは通信しない。アセットは `GF.assets.load()`（Phase 2） |
| `import(`, `eval`, `new Function` | 関数として直接書く。ライブラリは `<script src="/lib/…">` |
| `document.cookie`, `localStorage`, `indexedDB` | ゲームは保存しない。状態は変数に持つ |
| `window.open`, `location` への代入 | ゲーム内で完結させる |
| `Math.random` | `GF.rng()` |
| `Date.now`, `performance.now`, `new Date()` での時刻取得 | `GF.frame` |
| `setTimeout`, `setInterval`, `requestAnimationFrame` | `onTick` でフレームを数える。描画は `onDraw` |
| `<form>`, `<iframe>`, `<object>`, `<embed>` | 使わない |

次は拒否されないが警告が出る。

| 警告 | 内容 |
| --- | --- |
| 入力の直接購読 | `addEventListener('pointerdown', …)` 等は動くが、リプレイに記録されない。`GF.onInput` を使う |
| 点が動かない | `GF.score` への代入も `GF.end()` もない。点数ゲームとして成立しない可能性が高い |
| viewport | 自分で `<meta name="viewport">` を書いても SDK のものに置き換えられる |

## A.6 アセット（Phase 2。MVP では使えない）

MVP ではアセットを投稿できない。画像は canvas で描き、効果音は `/lib/zzfx` で合成する。以下は Phase 2 の規約で、先に決めてある。

| 種別 | 形式 | 1 ファイル上限 | 備考 |
| --- | --- | --- | --- |
| 画像 | WebP, PNG | 256 KB | SVG 不可。PNG は投稿時に WebP へ正規化 |
| 効果音 | Opus（.ogg） | 64 KB | WAV / MP3 で受け取り Opus へ正規化。48 kHz 以下 |
| 3D モデル | GLB | 512 KB | テクスチャは GLB 内包のみ |
| フォント | WOFF2 | 128 KB | |
| 投稿合計 | | 3 MB、32 ファイル | `required` 合計は 512 KB まで |

BGM はアセットにない。ゲームは 10 秒以内に終わるので、ゲーム単位の BGM は鳴り始める前に終わる。音楽はランの単位で Host が鳴らす。

参照は `./assets/<name>` で、`<name>` は英数字・`.`・`_`・`-`。コードからは `GF.assets.load('./assets/<name>')` で取得する。`required` を付けたものは開始前に揃い、それ以外は `load()` が解決するまで待つ。

## A.7 ライブラリ

`/lib/<name>@<version>.min.js` だけを `<script src>` で読み込める。バージョンは固定で、一覧にないものは拒否される。

| ライブラリ | 用途 | 注意 |
| --- | --- | --- |
| `three` | 3D 描画 | `Math.random` を内部で使うが、SDK が差し替えるので決定論は保たれる |
| `pixi` | 2D 描画 | |
| `matter` | 2D 物理 | 浮動小数の環境差が出うる。使うなら `gf:deterministic` を `false` に |
| `zzfx` | 効果音の合成 | 再生は `onStart` 以後に |

利用可能なバージョンの一覧は `/lib/` の配信側が持つ。ゲームは `@<version>` を省略できない。

## A.8 音

- 音を出すのは `onStart` 以後。`onInit` で鳴らさない（自動再生として止められる）
- 音量は `GF.audio.gain` を通す。Host の音量設定が上限になる
- 初回訪問の遊ぶ側はミュートで始まる。音がなくても遊べるようにする

## A.9 決定論性

同じシードと同じ入力列から、同じ `GF.score` が再現できることを規約とする。リプレイの描画と点数の検証がこれに乗る。

- 乱数は `GF.rng()` だけ。`onInit` の `seed` から初期化されている
- 時間は `GF.frame` だけ。実時間（`Date`、`performance`）に依存しない
- `onTick` の処理順を入力の到着順や描画の回数に依存させない
- `Math.sin` 等の浮動小数は使ってよいが、結果が環境でずれる可能性がある。物理エンジンのように積み重なる計算は `gf:deterministic="false"` を宣言する。宣言したゲームは点数の検証対象外になり、総合の記録には載らない
- `onDraw` の中で状態を変えない。検証時は `onDraw` を呼ばずに `onTick` だけを実行する

## A.10 点数

- `GF.score` は整数、0 以上、2,147,483,647 以下。大きいほど良い
- ゲームの意味での「点」は作る側が決める。耐えた時間、正確さ、倒した数、どれでもよい。尺度はプラットフォームが順位に直す
- `gf:target` は「上手い人がこれくらい」の値。記録が貯まるまでの仮の基準にしか使われないので、厳密でなくてよい。ただし 0 や、誰も届かない値は避ける
- 時間とともに減る点数でもよいが、報告されるのは終了時の `GF.score` だけ

## A.11 投稿時の検査と結果

`publish_game` はまず静的検査を行い、拒否なら `error`、通れば `warnings` を返す。拒否の各項目には `fix`（直し方）が付く。

| code | 拒否 / 警告 | 意味 |
| --- | --- | --- |
| `SIZE` | 拒否 | 128 KB 超 |
| `META_TITLE` | 拒否 | `<title>` がない・空 |
| `META_DURATION` | 拒否 | `gf:duration` がない・整数でない・180〜600 の外 |
| `META_VERB` | 拒否 | `gf:verb` がない・空・9 文字以上 |
| `META_INPUT` | 拒否 | `gf:input` がない・`tap` / `hold` / `swipe` 以外 |
| `META_TARGET` | 拒否 | `gf:target` がない・1 以上の整数でない |
| `FORBIDDEN_API` | 拒否 | A.5 の識別子を使っている（行番号つき） |
| `EXTERNAL_REF` | 拒否 | A.2 の読み込み先以外を参照している |
| `DIRECT_INPUT` | 警告 | 入力イベントを直接購読している |
| `NO_SCORE` | 警告 | `GF.score` への代入も `GF.end()` もない |
| `VIEWPORT` | 警告 | `<meta name="viewport">` を自分で書いている |

検査は字句レベルで、コメントと文字列リテラルの中は見ない。検査を通っても、実行時に動かないものは動かない（A.5 の差し替え）。

## A.12 投稿の流れ（AI が行うこと）

1. `publish_game` に `html` と `title` を渡す。初回は下書きができ、`post_id` と試遊 URL が返る
2. 拒否されたら `fix` に従って直し、同じ `post_id` を渡して再投稿する（下書きの内容が置き換わる）
3. 作者に試遊 URL を開いて遊んでもらう。試遊ページには「診断をコピー」があり、作者が貼ってきた診断文（`end` が呼ばれなかった、例外、点が動かない、1.5 倍で終わらない）に従って直す
4. 作者が公開を望んだら `publish_game` に `publish: true` を付けて呼ぶ。公開後は内容を変えられない。直すなら新しい下書きにする

## A.13 最小の例

タップで落ちてくる丸を消す 5 秒のゲーム。これだけで規約をすべて満たす。

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>まるタップ</title>
<meta name="gf:duration" content="300">
<meta name="gf:verb" content="タップ！">
<meta name="gf:input" content="tap">
<meta name="gf:target" content="12">
<style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let circles = [];                 // { x, y, r, vy } 座標は 0〜1
let taps = [];                    // onInput で受けて、次の onTick で処理する

GF.onInit(() => { circles = []; taps = []; GF.score = 0; });

GF.onInput((ev) => { if (ev.kind === 'tap') taps.push(ev.data); });

GF.onTick((frame) => {
  for (const [x, y] of taps) {
    const i = circles.findIndex(c => (c.x - x) ** 2 + (c.y - y) ** 2 < c.r ** 2);
    if (i >= 0) { circles.splice(i, 1); GF.score += 1; }
  }
  taps = [];
  if (frame % 20 === 0) {
    circles.push({ x: 0.1 + GF.rng() * 0.8, y: -0.05, r: 0.06, vy: 0.006 + GF.rng() * 0.004 });
  }
  for (const c of circles) c.y += c.vy;
  circles = circles.filter(c => c.y < 1.1);
});

GF.onDraw(() => {
  const w = canvas.width = canvas.clientWidth;
  const h = canvas.height = canvas.clientHeight;
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffd400';
  for (const c of circles) {
    ctx.beginPath(); ctx.arc(c.x * w, c.y * h, c.r * w, 0, Math.PI * 2); ctx.fill();
  }
});
</script>
</body>
</html>
```

---

# B. 解説（規則の理由と却下した案）

## B.1 なぜ 3〜10 秒、入力 1 種か

連続で遊ぶランの単位にするため。遊ぶ側は幕間で動詞とアイコンを見て 1 秒後に入ってくるので、操作を覚える時間がない。5 秒固定（WarioWare 型）は点数の幅を殺すので 3〜10 秒に広げたが、10 秒超は「上手い人ほど 1 本が長い」構造でランの長さが読めなくなるため受け付けない（`product.md` 6）。

## B.2 なぜ点数で、勝敗ではないか

`product.md` 5.1。勝敗 2 値は記録の分散が小さく、作る側が「耐えた・正確だった」を表現できない。点数の意味を揃えないのは、順位に直せばゲーム間で比較できるため。`gf:target` は記録が貯まるまでの仮基準で、作者の実プレイの点数を基準にする案は、作者が手を抜く・上手すぎる・やり込んでいるとは限らない、の 3 点で採らない。

## B.3 なぜ 1.5 倍速で成立することを求めるか

エンドレスは山札を周回し、周回ごとに速くなる（`product.md` 4.2）。速度を「論理時間の進みを速める」方式にしたのは、ゲームの中身を変えずにリプレイも検証もそのまま効くため。上限を 1.5 倍に置いたのは、作る側に「速くなっても解けるか」だけ考えさせるため。2 倍まで求める案は、tap 1 種のゲームで反応時間が人間の限界を超えるため採らない。

## B.4 なぜ 128 KB で、`data:` URI を禁止するか

リミックス（Phase 2）のとき、ゲームのコードは AI のコンテキストに丸ごと載る。128 KB はそのための上限で、base64 の画像や音声を載せるのは無駄なので、アセットはコードから分離する。128 KB を超えるコードはほぼ確実にアセットの埋め込みを含む。

## B.5 なぜ乱数と時間を差し替えるか

リプレイ（プレビュー動画の生成、点数の検証）は「シード + 入力ログ」から再現できることに依存する。`Math.random` と実時間があるとこれが壊れる。静的検査で拒否するだけでなく実行時に差し替えるのは、ライブラリ内部の呼び出し（three.js の `Math.random` など）も同じ乱数列に乗せるため。差し替えを「throw」ではなく「シード付き実装への置き換え」にしたのも同じ理由。

## B.6 なぜ静的検査は字句レベルで止めるか

難読化（`window['fe'+'tch']`）は検出できないが、それで得られるものがない。本当の防御線はサンドボックス（`security.md`）で、静的検査の役割は「善意の作者が誤って非決定的なゲームや外部参照を投稿する」のを防ぎ、直し方を伝えること。AST を取る検査は、AI が書く多様なコードに対して誤検出が増え、`fix` を書けなくなる。

## B.7 なぜ BGM をアセットから外すか

ゲームは 10 秒以内に終わる。512 KB の BGM は `required` にできず、`start` 後に読むと鳴り始める前に終わる。構造的に鳴らないものを規約に残さない。音楽はランの単位で Host が鳴らす（暫定）。

## B.8 なぜローカルで動かす SDK を配らないか

`product.md` 9。対象ユーザーはスマホで HTML を保存できず、本番と違う環境で確かめると sandbox / CSP の差で本番だけ動かない事故を呼ぶ。下書きの試遊ページが唯一の確認環境で、「診断をコピー」が AI への戻り道になる。

## B.9 なぜ `GF.score` をプロパティにし、`end(score)` 引数にしないか

時間切れは SDK が終える。そのとき SDK が点を知っている必要があり、ゲームに「時間切れのコールバックで点を返す」を書かせるより、常に `GF.score` を最新にしておく方が AI が間違えにくい。`GF.end()` は早く終えるときのためだけに残す。旧設計の `onTimeout` で `win` / `lose` を返す方式は、点数制への変更で不要になった。

## B.10 `tilt` を現在受け付けない理由

iOS で加速度センサーの許可ダイアログがユーザー操作を要求し、幕間からの流れで出すと止まる。Phase 2 で、ランの開始時に 1 回だけ許可を取る形を試す。

## B.11 入力の直接購読を拒否ではなく警告にする理由

動きはするのでゲームとして壊れないが、リプレイには載らない。拒否にすると、`GF.onInput` 以外の UI（たとえばキャンバス外のボタン）が一切書けなくなる。警告で `fix` を伝え、校正時の分布検査（`product.md` 5.4）で「点が動かない」に落ちれば作者に通知される。

---

## 未解決

- `/lib/` の初期一覧とバージョン固定の運用（誰がいつ上げるか）。`security.md` と `data-model.md` で決める
- `hold` の `data` に経過フレームを含めるか。SDK 実装時に決める
- A.6 のアセットは Phase 2 まで `gf://guide` に含めるかどうか。含めると AI が使おうとする可能性があるので、MVP の間は A.6 を「使えない」の一文だけにする案がある
