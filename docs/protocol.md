# Host–Guest プロトコル（protocol）

2026-11-06 作成。前提は `docs/product.md` と `docs/game-contract.md`（SDK の API）。読む人は SDK と Host（ラン画面、試遊ページ、サーバの描画・検証ハーネス）の実装者。
節番号は `pr#3` のように参照する。A 部が規約、B 部が理由。

---

# A. 規約

## A.1 用語と前提

| 用語 | 意味 |
| --- | --- |
| Host | iframe を埋め込む側。ラン画面、下書きの試遊ページ、サーバの描画・検証ハーネス（headless Chromium）の 3 種類がある |
| Guest | iframe の中。ゲームの HTML と、配信時に注入された SDK |
| セッション | 1 つの `session_id` で表す、1 回のプレイまたは再生。Host が発行する |
| 論理フレーム | ゲームの時間の単位。60 フレーム = ゲーム内の 1 秒。実時間との対応は `speed` で変わる |
| 監視タイマー | Host が `start` 時に動かす壁時計のタイマー。満了でセッションを終える |

Host と Guest は `postMessage` だけで話す。Guest は不透明オリジン（`security.md`）なので、Host は `event.source` が自分の iframe の `contentWindow` と一致することで送り元を確かめ、`origin` は検査しない。Guest は `event.source === window.parent` を確かめる。

## A.2 ワイヤ形式

各メッセージは `{ "type": "...", ...ペイロード }` のフラットな JSON 1 つ。キーは snake_case。入れ子の `payload` は使わない。

- Guest は `ready` 以外のすべてのメッセージに `session_id` を載せる
- 受け取った側はスキーマで検証し、余計なキー・型違い・未知の `type` は**即セッション破棄**（Host は `destroy` を送って iframe を外す。Guest は以後すべて無視する）
- プロトコルのバージョンは `ready.sdk` で伝える。現在は `"2.0"`。Host は自分が知らないメジャーを拒否する

## A.3 メッセージ一覧

Guest → Host:

| type | ペイロード | 送るとき |
| --- | --- | --- |
| `ready` | `sdk, title, verb, input, duration, target` | SDK の初期化が終わった直後に 1 回。値は `game-contract.md` A.3 のメタ宣言 |
| `log` | `session_id, from_frame, inputs` | 64 フレームごとと、`end` の直前。`inputs` は `[frame, kind, ...data]` の配列 |
| `end` | `session_id, score, frames` | ゲームが終わったとき 1 回。`score` は整数 0〜2³¹−1、`frames` は終了時のフレーム番号（`time_limit` 以下） |
| `error` | `session_id, message` | ゲームのコールバックで例外が出たとき 1 回。以後そのセッションでは何も送らない |

Host → Guest:

| type | ペイロード | 送るとき |
| --- | --- | --- |
| `init` | `session_id, seed, mode, time_limit, speed, inputs?` | セッションの準備。`mode` は `play` か `replay`。`replay` では `inputs` 必須。`speed` は 1.0〜1.5 |
| `start` | なし | フレームを進め始める |
| `pause` / `resume` | なし | 止める・再開する。フレームは進まない |
| `destroy` | なし | 破棄の予告。Guest は音を止める。直後に iframe が外される |

`log.inputs` の各要素:

| kind | 要素 |
| --- | --- |
| `tap` | `[frame, "tap", x, y]` |
| `hold` | `[frame, "hold", x, y, 1]` / `[frame, "hold", x, y, 0]` |
| `swipe` | `[frame, "swipe", x0, y0, x1, y1]` |
| `drag` | `[frame, "drag", x, y, 1]` / `[frame, "drag", x, y, 0]`。`x, y` は 1/256 に量子化 |

`stick` はログに現れない。SDK が `drag` 列から解釈する（`game-contract.md` A.4）。`tilt` は予約。

## A.4 セッションの流れ

```
Guest: ready
Host : init(session_id=s1, seed, mode=play, time_limit, speed)
Host : start                      ← 監視タイマー開始
Guest: log, log, …                ← 64 フレームごと
Guest: log（最後の分）, end(s1)   ← または Host の監視タイマー満了
Host : destroy                    ← または init(s2) で再利用（A.6）
```

- Host は `ready` を受け取るまで何も送らない。`ready` より前に届いた Host のメッセージを Guest が受け取ることはない
- `init` を受けた Guest は、そのセッションの状態を初期化し（`onInit`）、`start` を待つ。`start` の前にフレームは進まず、入力も記録しない
- `start` を受けた Guest は `onStart` を呼び、以後 `speed × 60` 回/秒で `onTick` を呼ぶ。描画は端末の `requestAnimationFrame` に合わせて `onDraw` を呼ぶ。遅れたときは 1 描画あたり最大 5 tick まで追いつき、それ以上は捨てずに次に持ち越す
- 入力は DOM イベントの時点で受け、**次の tick のフレーム番号**を付けてログに入れ、その tick の前に `onInput` へ渡す
- `frame == time_limit` に達した tick の直後に、SDK は `GF.end()` と同じ処理（最後の `log` と `end`）を行う。ゲームが先に `GF.end()` を呼んでいればその時点で行い、以後の tick は止める
- `end` は 1 セッションに 1 回。SDK は 2 回目以降の `GF.end()` を無視する

## A.5 Host の状態機械

状態は 7 つ。受理する組は次の表のとおりで、表にない組は捨てる（破棄はしない。スキーマ違反だけが破棄）。

| 状態 | 受理するもの | 遷移 |
| --- | --- | --- |
| LOADING | `ready` | → READY |
| READY | `init` | → INITED |
| INITED | `start` | → RUNNING（監視タイマー開始） |
| RUNNING | `pause` → PAUSED（タイマー停止・残り時間を保存）/ `log` / `end` → ENDED / `error` → ENDED / 監視タイマー満了 → ENDED | |
| PAUSED | `resume` → RUNNING（残り時間でタイマー再開）/ `log` / `end` → ENDED / `error` → ENDED | |
| ENDED | `init` → INITED | 同じ iframe の再利用（A.6） |
| DESTROYED | なし | |

`destroy` はどの状態からも DESTROYED へ遷移する（LOADING を含む）。

`session_id` の照合: `log` / `end` / `error` は現在の `session_id` と一致するものだけ受理する。一致しないものは捨てる（古いセッションの遅延到着）。

`end` の受理条件: RUNNING または PAUSED、`session_id` が一致、**かつ監視タイマーが満了していない**。PAUSED 中はタイマーが止まっているので、PAUSED で届いた `end` は常に受理される。

## A.6 iframe の再利用

ENDED から `init` で INITED に戻れる。使うのは下書きの試遊ページの「もう一回」と、サーバの描画・検証ハーネスだけ。ランでは Host が次のゲームへ進むので再利用しない（`run.md`）。

PAUSED からの `init` は認めない。やり直すなら `destroy` して作り直す。

## A.7 監視タイマーと終わり方

- 長さは `time_limit ÷ (60 × speed)` 秒 ＋ 1.5 秒。`start` で始まり、`pause` で止まり、`resume` で残り時間から再開する
- 満了したら Host は ENDED へ遷移し、結果を `via: timeout`、`score: 0`、`frames: time_limit` として記録する。以後その `session_id` の `end` は捨てる
- `error` を受けたときも ENDED で、`via: error`、`score: 0`
- SDK は `time_limit` で必ず `end` を送るので、満了が起きるのはゲームが固まった（無限ループ）か、`end` の前に例外で止まったときだけ

終わり方は 3 通りで、それぞれ記録の扱いが違う（`scoring.md`、`run.md`）。

| via | ゲームの記録（校正・分布） | 遊ぶ側のラン |
| --- | --- | --- |
| `guest` | `score` をそのまま | 偏差値に直して成績に入る |
| `timeout` | `score: 0` として入る（固まるゲームは 0 に張り付いて検出される） | `skip`。残機も成績も触らない（遊ぶ側のせいではない） |
| `error` | 同上 | 同上 |

## A.8 `speed`

- `init.speed` は 1.0 以上 1.5 以下。Host が決め、Guest は変えられない
- Guest は `speed × 60` 回/秒で `onTick` を呼ぶ。論理フレームの意味（`time_limit`、`frames`、ログの `frame`）は `speed` に依存しない
- `replay` では元のセッションと同じ `speed` を渡す。入力はフレーム番号で記録されているので、実時間の長さが違っても同じ結果になる
- Host は `end.frames` を `time_limit` 以下として検証する。壁時計との整合（`frames ÷ (60 × speed)` が経過時間 × 1.05 以下）は `scoring.md` の検証段階で行う

## A.9 `log` の組み立て

- `from_frame` は厳密に増加する。Host は減る・重なる `log` を捨て、そのセッションを `flagged` にする（`scoring.md`）
- `end` の直前の `log` で、`inputs` は `end.frames` までをすべて含む。Host は `end` 受理時に、`log` の最大フレームが `end.frames` を超えていないことを検査する
- Host は `log` を連結して 1 本の入力ログにし、`seed` と `speed` と一緒に保存する。これがリプレイの材料になる

## A.10 Guest の振る舞い（SDK が保証すること）

- `ready` の前に Host のメッセージは届かない前提だが、届いても捨てる
- `init` は READY / ENDED / RUNNING(replay) で受理する。RUNNING(play) 中に `init` が来ることはない（Host が送らない）。来たら捨てる
- `start` は INITED でだけ受理。`pause` は RUNNING でだけ、`resume` は PAUSED でだけ。それ以外は捨てる
- `destroy` を受けたら音を止め、以後すべてのコールバックを呼ばない
- コールバック（`onInit` / `onStart` / `onTick` / `onDraw` / `onInput`）で例外が出たら、最初の 1 回だけ `error` を送り、以後そのセッションでは何も送らない。`end` の後の例外は無視する
- `GF.score` は `end` を送るときに整数・0 以上・2³¹−1 以下にクランプする
- `Math.random` / `Date.now` / `performance.now` / `setTimeout` / `setInterval` / `requestAnimationFrame` / `fetch` をシード付き乱数・フレーム由来の時刻・無効化に差し替える（`game-contract.md` A.5）。差し替えは `ready` より前に行う

## A.11 試遊ページとハーネスでの使い方

- 下書きの試遊ページは play モードの Host で、デバッグ表示（フレーム、残り時間、`score`、速度スライダー、入力、例外）はこのプロトコルの観測だけで作る。速度スライダーは `init.speed` を変えて `init` し直す
- サーバの描画ハーネスは `replay` モードで `onDraw` あり、検証ハーネスは `replay` モードで `onDraw` なし（SDK の `GF_HEADLESS` フラグで切り替え）。どちらも `end.score` を受け取って終わる

## A.12 検査する性質

形式検証（`verification/Session.tla`）と単体テストで確かめる性質。TLA+ モデルは旧設計のもので、この文書に合わせた改訂は `verification/` の PR で行う。

| ID | 性質 |
| --- | --- |
| P1 | 1 つの `session_id` につき受理される `end` は高々 1 つ |
| P2 | 受理した `end` の `session_id` は Host の現在セッションと一致し、`play` のときだけ記録になる |
| P3 | 現在セッションの `end` を Host が捨てるのは、監視タイマーが満了した後だけ |
| P4 | Guest が送ったプレイセッションの `end` は、iframe 破棄か監視タイマー満了以外で失われない |
| P11 | 監視タイマー満了で ENDED になるのは RUNNING のときだけで、満了時刻を過ぎている |
| P12 | 満了後にその `session_id` の `end` が受理されることはない |
| P13 | PAUSED の間、残り時間は減らない |

---

# B. 解説（規則の理由と却下した案）

## B.1 `media` を廃止した理由

旧設計では Guest がサムネイル（`thumb`）と録画（`video`）を `media` で送っていた。プレビューと共有物はサーバが headless Chromium でリプレイを描画して作る（`product.md` 8）ので、Guest からバイナリを受け取る経路が要らなくなった。消すことで、状態機械から `media` の重複・サイズ検査が消え、iOS Safari の `captureStream` に依存しなくなる。

## B.2 `end` から `result`（勝敗）と `checkpoint` を外した理由

勝敗は点数に置き換えた（`product.md` 5.1）。`checkpoint`（ゲーム状態のハッシュ）は検証を強くするが、ゲームに状態のハッシュ計算を書かせることになり、AI が間違えやすい。検証は `score` の一致だけで行い、足りなければ後から optional で足す。

## B.3 監視タイマー満了を `score: 0` と `skip` に分けた理由

満了は SDK が `end` を送れなかったときにしか起きないので、ほぼ確実にゲーム側の不具合（無限ループ、例外）。ゲームの記録としては 0 を入れて「0 に張り付く」分布検査（`product.md` 5.4）で捕まえたい。一方、遊ぶ側に残機を失わせるのは筋が違うので、ランでは `skip` と同じ扱いにする。1 つの事象を 2 つの帳簿で別に数える、という決定。

## B.4 PAUSED からの `init` を認めない理由

形式検証で見つけた競合（旧 `spec.md` 13 章の反例 3）。pause → resume → pause の後に古い `paused` ACK が届くと Host が誤って再初期化し、resume 後に Guest が送った `end` が旧セッションとして捨てられる。ACK を廃止し、PAUSED からの `init` を禁止することで消える。やり直したいなら `destroy` して作り直す。

## B.5 `end` を PAUSED でも受理する理由

同じく形式検証の反例 2。Host が `pause` を送るのと同時に Guest が `end` を送ると、Host は PAUSED で `end` を受け取る。RUNNING 限定にすると正当な結果が消える。PAUSED 中はタイマーが止まっているので、PAUSED で届いた `end` を無条件に受理しても満了との競合は起きない。

## B.6 `session_id` を全 Guest メッセージに載せる理由（#27）

Showcase 再生中のタップで `init(s2)` を送った直後に、遅れて届く s1 の `end` をプレイのスコアとして受理する事故（旧反例 1）を防ぐ。`end` だけでなく `log` / `error` も照合するのは、古いセッションの `log` が新しいセッションのログに混ざるのを防ぐため。`ready` はセッションの前なので載せない。

## B.7 `speed` を `init` で渡し、tick ごとのメッセージにしない理由

Host が毎フレーム `tick` を送る方式は、postMessage の遅延がそのままゲームの揺れになる。SDK が自分の `requestAnimationFrame` でループを回し、`speed` だけ Host が決める方が安定する。`speed` をセッションの途中で変えないのは、リプレイの再現に「どのフレームで速度が変わったか」を持ちたくないため。

## B.8 ワイヤ形式をフラットにした理由（#27）

`{type, payload}` の入れ子は、`type` ごとにスキーマを切り替える実装が 1 段深くなるだけで利点がない。フラットなら valibot の `variant` で 1 回の検証になる。

## B.9 Guest 側で `origin` を検査しない理由

Guest は CSP の `sandbox` で不透明オリジンになり、`event.origin` は `"null"` になる。Host の `origin` を Guest に教える手段が別に要る。`event.source === window.parent` の照合で、親以外からのメッセージは防げる。親は Host 以外ありえない（`frame-ancestors`、`security.md`）。

---

## 未解決

- `log` の 64 フレームごとという間隔。`speed` が 1.5 のとき実時間で 0.7 秒ごとになる。短くする必要があるか、SDK 実装時にログの大きさと見比べて決める
- `init.speed` の取りうる値。連続値か、1/8 刻みの離散値か。`run.md` の速度スケジュールと合わせて決める
- `error.message` の長さ上限と、スタックトレースを含めるか。試遊ページの診断に必要な分だけ残す
