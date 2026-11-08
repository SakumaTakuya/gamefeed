# 形式検証（verification）

仕様のうち並行性・状態遷移が絡む 4 箇所を TLA+ でモデル化し、TLC で有限境界の全状態を網羅検査する。旧 `spec.md` 13 章の「別添」はリポジトリに存在したことがなく、ここにあるモデルは 2026-11-08 に新文書（`docs/protocol.md`・`run.md`・`scoring.md`・`moderation.md`・`data-model.md`）から書き起こしたもの（#68）。

`scoring_check.py` は数値の検査（`scoring.md` A.11 の S1〜S6）で、TLA+ ではない。`python3 verification/scoring_check.py` で走る。

## 実行

```sh
curl -sL -o tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
cd verification
java -cp ../tla2tools.jar tlc2.TLC -deadlock -config Session.cfg Session.tla
java -cp ../tla2tools.jar tlc2.TLC -deadlock -config Run.cfg Run.tla
java -cp ../tla2tools.jar tlc2.TLC -deadlock -config Lifecycle.cfg Lifecycle.tla
java -cp ../tla2tools.jar tlc2.TLC -deadlock -config Moderation_2u2p.cfg Moderation.tla
```

- `-deadlock` は「デッドロックを誤りとしない」。遊ぶ側が止まれば進まない系なので、終端状態は誤りではない
- 設計の分岐は cfg の定数で切り替える。`*_noSid` / `*_noPaused` / `*_literal` / `*_norecheck` / `Lifecycle_asis` は「素朴な設計」や修正前の文言で、反例が出るのが正しい
- TLC は `states/` と `*_TTrace_*` を書く。`.gitignore` 済み

## モデル → 性質 → 要件

| モデル | 対象 | 性質 | 要件 ID |
| --- | --- | --- | --- |
| `Session.tla` | Host の状態機械（pr#A.5〜A.7）と Guest（pr#A.10）を非同期 FIFO で結ぶ。監視タイマーは離散時刻で、RUNNING でだけ進む | P1〜P4, P11〜P13（pr#A.12） | R-6.4-1 |
| `Run.tla` | 手番の発行・スロット N〜N+2・幕間と skip・残機とミス（run#A.3〜A.7）。サーバの `finish` 規則（sc#A.9） | F1〜F9（run#A.15） | R-8.2-3, R-run.A15-1, R-run.A7-2 |
| `Lifecycle.tla` | 1 投稿の校正状態（sc#A.7）× 投稿状態（mo#A.2）× 制限と、`limited → public` の昇格、`post_eligibility`（dm#A.4） | L1〜L6（この README で定義） | （R-sc.* / R-mo.* の補助） |
| `Moderation.tla` | 2 ユーザー・投稿 3 件の投稿状態・系譜・通報・自動制限・運営操作・ツリー制限・BAN（mo#A.2, A.4〜A.7、dm#A.4, A.5） | M1〜M10（mo#A.10） | R-mo.A10-1 |

### 性質の対応（文書の ID → モデルの定義）

| 文書の ID | モデルでの定義 | 種類 |
| --- | --- | --- |
| P1 | `hAccepted[s] <= 1` | 不変条件 |
| P2 | 受理時に `m.sid = hSid` が常に成り立ち（`~hMismatch`）、記録になる sid は `init` で `play` を渡したもの | 不変条件 |
| P3 | `hSid \in hDropped => hSid \in hExpired \/ DESTROYED` | 不変条件 |
| P4 | 捨てた `end` の sid はすべて満了済み（または DESTROYED） | 不変条件 |
| P11 | 満了の直前の状態は RUNNING（`hExpireFrom`）。`hTimer = 0` は `HostExpire` のガード | 不変条件＋ガード |
| P12 | `hExpired` の sid の `hAccepted` は 0 | 不変条件 |
| P13 | `[][PAUSED => hTimer' >= hTimer]` | アクション性質 |
| F1 / F2 / F4 | RUNNING は高々 1 つで `cur`、生存 iframe は 3 以下 | 不変条件 |
| F3 | 生存 iframe ⊆ `{cur} ∪ Candidates`、`|Candidates| <= 2`。**スロットを手番番号でなく位置と読む**（下の穴 1） | 不変条件 |
| F5 | `[][frame'[t] = RUNNING かつ frame[t] # RUNNING => frame[t] = INITED]` | アクション性質 |
| F6 | `<>finished`（`WF_vars(Next)`） | 活性 |
| F7 | `missTurns` に `isNew` の手番がない | 不変条件 |
| F8 | `~startedAfterZero`（残機 0 で `start` を送った履歴がない）。`Cheat = FALSE` でだけ検査 | 不変条件 |
| F9 | `finish` 時、サーバの到達本数は Host の 3 回目のミスの手番を超えない（結果を送らない `Withhold`、残機を無視する `Cheat` でも）。全部送れば 3 回目のミスの手番と一致し、ミスが 3 回未満なら最後に報告した手番。未提出の手番は run#A.7 / sc#A.9 の規則（最後の結果より後は数えず、前は `miss_below` ありならミス・なしなら skip） | 不変条件 |
| L1 | `invalid` は終端 | アクション性質 |
| L2 | `uncalibrated → calibrated` は `n >= 20`（`enough`）でだけ | アクション性質 |
| L3 | `normal` ⇒ `public ∧ calibrated`、`new` ⇒ `limited/public ∧ uncalibrated ∧ thumb`、それ以外は `none`（dm#A.4） | 不変条件 |
| L4 | 可視の `limited ∧ calibrated` は `upheld` を持つ（mo#A.8 表） | 不変条件。#71 より前の文言（`Lifecycle_asis.cfg`）では不成立 |
| L5 | 昇格が制限中の投稿を可視にしない（M8 の 1 投稿版） | アクション性質 |
| L6 | 記録が分布に入るのは `new` 枠のときだけ | アクション性質 |
| M1 | `parent < id`、`parent` は挿入後不変 | 不変条件＋アクション性質 |
| M2 | `banned` のユーザーの行はすべて `removed` | 不変条件 |
| M3 | `removed` から出ない | アクション性質 |
| M4 / M5 | `indiv` の投稿、ロック根の子孫は不可視 | 不変条件 |
| M6 | 親の行は消えない（消えるのは子を持たない `draft` だけ） | 不変条件 |
| M7 | `unpublished` から出る先は `limited / public / removed` | アクション性質。内容はモデルにない（dm#A.5 I10 により `draft` 以外で変わらない） |
| M8 | 制限が残る投稿は、どの遷移の後も不可視 | アクション性質 |
| M9 | `indiv` が下りるのは `Restore`、ロックが消えるのは `RestoreTree` でだけ | アクション性質 |
| M10 | 運営の `restrict` 以外で `indiv` が立つのは、サインイン主体の通報が `open` のときだけ | アクション性質 |

## 結果（2026-11-08、tla2tools 1.8.0、Java 21、1 CPU / 3 GB）

| cfg | 設計 | 結果 | 状態数（distinct） |
| --- | --- | --- | --- |
| `Session.cfg` | 採用（sid 照合あり、PAUSED で `end` 受理）。MaxSid 3、チャネル長 3、タイマー 2 | **反例なし** | 105,984 |
| `Session_noSid.cfg` | sid 照合なし | **P2 / P12 違反**（13 手）。満了で ENDED → `init(2)` の後、遅れて届いた `end(1)` を現在セッションとして受理 | — |
| `Session_noPaused.cfg` | RUNNING でだけ `end` 受理 | **P3 違反**（9 手）。Guest の `end` と Host の `pause` が交差し、PAUSED で届いた `end` を捨てる | — |
| `Run.cfg` | 採用。Cap 6、Lives 2 | **反例なし**（F6 含む） | 153,724 |
| `Run_withhold.cfg` | `result` を送らないことがある Host（run#A.7 の `abandoned` 規則、#74） | **反例なし** | 3,681,729 |
| `Run_cheat.cfg` | 残機 0 を無視する Host（F9 用） | **反例なし** | 223,769 |
| `Run_cheat_withhold.cfg` | 残機無視＋未提出 | **反例なし** | 6,155,229 |
| `Run_literal.cfg` | A.5 step 6 / 7 を文字どおり（`cur + 2` より先を発行しない） | **F6 違反**。`start(1)` → `end` → 2 を skip → 3 を skip で候補が尽き、発行規則がなく停止 | — |
| `Lifecycle.cfg` | `moderation.md` A.7 どおり（`restore` で昇格、#71） | **反例なし** | 1,723 |
| `Lifecycle_asis.cfg` | #71 より前の文言（`RestorePromotes = FALSE`） | **L4 違反**（6 手）。下の穴 2 | — |
| `Moderation_norecheck.cfg` | 挿入時に `users.status` を再確認しない | **M2 違反**（3 手）。`Check(u1)` → `Ban(u1)` → `Insert(u1)`。旧反例 4 | — |
| `Moderation_2u2p.cfg` | 採用。2 ユーザー・投稿 2 件 | **反例なし** | 2,712,272（3 分 53 秒） |
| `Moderation_1u3p.cfg` | 採用。1 ユーザー・投稿 3 件 | **未完走**。20 分で 1.4 億状態生成 / 1,290 万 distinct でキューが増え続け、以後進まなくなった（メモリ 3 GB の限界） | — |
| `Moderation.cfg` | 採用。2 ユーザー・投稿 3 件 | **未完走**。1 CPU で 1,400 万状態生成 / 260 万 distinct の時点で中断。別環境（複数 CPU・メモリ 8 GB 以上）か、`open` を 2 値にする・`RestrictUser` を外すなどの削減が要る | — |

旧 13 章の 6 つの欠陥との対応: 反例 1・2・4 は上のとおり「素朴」設定で再現し、採用設計では出ない。反例 3（`paused` ACK）は新プロトコルに ACK がなく、PAUSED からの `init` も `HostInit` に含めていないので構造的に起きない。反例 5・6（可視性の導出）は `Moderation.tla` の `Status` が導出値で、M4 / M5 が成立することで確認している。

## モデルが指した仕様の穴（2026-11-08 にオーナー承認、#71 / #75 / #76 / #77 で文書を直した。以下は発見時の記述）

1. **run#A.5 step 6 / 7: 先読み 2 枚が続けて skip になると次の手番を発行する規則がない。** step 7 は「`start` を送ったら新しい N+2 を取る」とだけ書き、step 6 の skip の後に補充する記述がない。A.15 F3「N〜N+2 の部分集合」を手番番号で読むと、skip の後に `cur + 3` を発行できず、`Run_literal.cfg` で F6（ランは必ず終わる）が破れる。`Run.tla` はスロットを「表示中＋先読み 2 枚」の位置と読み、skip で空いた位置に次の手番を発行する。文書に「skip で空いたスロットは `next` で埋める」を足し、F3 を「生存 iframe は表示中の手番と、その次に出す手番 2 本まで」と言い換えることを提案する。
2. **mo#A.2 / A.7 / A.8: `limited` かつ `calibrated` の投稿が永久に `limited` に取り残される。** 経路: 自動制限（`indiv_restricted`、通報は `open` のまま）→ 校正済みになる（制限中なので昇格しない）→ 運営の `restore`（`indiv` を下ろし、通報は `dismissed`）。このとき投稿は可視・`calibrated`・`upheld` なし・制限なしだが `limited` のままで、A.7 の操作一覧に昇格させる操作がない（A.2 の「復帰は運営」に対応する操作が存在しない）。A.8 表の「起きていれば制限か `upheld` がある投稿」は成り立たない（`Lifecycle.cfg` の L4 違反）。提案: `restore`（と `restore_tree`）で、対象が `limited ∧ calibrated ∧ upheld なし` なら同じトランザクションで `public` に昇格する（`Lifecycle_fix.cfg`、`RestorePromotes = TRUE` で全性質成立）。`calibration_confirm`（`review → calibrated`）が昇格するかは A.2 の「`calibrated` になる遷移」に含まれると読み、モデルはそう書いた。文書に明記したい。
3. **mo#A.5 の BAN「`removed` でない投稿をすべて `removed`」は `draft` を含むか。** A.2 / B.6 は `draft` を `removed` にしないので、`Moderation.tla` は BAN で `draft` を削除（行を消す）として扱った。I3 の文言（「投稿はすべて `removed`」）とどちらかに揃えたい。
4. **run#A.7 / sc#A.9 の `finish`: `result` を送らなかった手番の扱い。** 到達手番数は「3 回目のミスが起きた手番まで」だが、3 回目のミスの `result` を送らず遊び続けるクライアントではその手番が `open`（期限切れ後は `abandoned`）のまま残る。`abandoned` を到達数に含めるか、ミスとみなすかが書かれていない。`Run.tla` の F9 は「結果はすべて届く」前提で検査している（`Cheat = TRUE` は残機の無視だけ）。 → #77 で規則を決め、`Run_withhold.cfg` で再検査した（#78）。

## 境界と限界

- 有限境界。Session は sid 3・チャネル長 3・タイマー 2 tick、Run は手番 6・残機 2、Moderation は投稿 2〜3 件。境界を超えて初めて現れる誤りは見つけられないが、性質は構造的で境界に依存しにくい
- `Session.tla` は `log` を運ばない（状態を変えないので、`from_frame` の検査は単体テスト）。Guest の壁時計は「`end` を送る／送らない」の非決定で表す
- `Run.tla` は pause / resume（run#A.9）と速度を持たない。Session 側で検査している
- `Moderation.tla` は通報の重みを持たない。自動制限は「サインイン主体の `open` な通報があるとき起きうる」非決定で、閾値の値は検査しない。信頼スコアは「30 以上か」の 2 値
- `Run.tla` は Host が `result` の応答を待ってから `finish` を呼ぶ（run#A.7）を原子的に扱い、`result` と `finish` の到着順の入れ替わりは検査しない
- 活性は F6 だけ。他は安全性
- モデルと実装は別物。反例トレース（上の表の手数）は実装の integration テストのシナリオにできる
