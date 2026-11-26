# 画風カード: ドット絵（`dot`）

小さな画面に少ない色で描き、補間なしで引き伸ばした絵。

## 配色

| 役 | 色 |
| --- | --- |
| 地 | `#141433` |
| 遠景 | `#2a2f6e` / `#5762d5` |
| 白 | `#f2f0e6` |
| 取る物 | `#ffd23f` |
| 動かす物、危険 | `#ef476f` |
| 地面 | `#2e9e68` / `#1f6f4b` |

8 色まで。途中の色（半透明、グラデーション）を作らない。

## 決まり

- 絵は 90 × 160 の小さな canvas に描き、表示の canvas へ `imageSmoothingEnabled = false` で引き伸ばす
- 座標は整数に丸める。半端な位置に描かない
- 物は文字の行で書いたスプライトで描く。丸や斜めの線を `arc` や `lineTo` で描かない
- 動きはコマで見せる（2 コマの切り替えで足りる）。回転と拡大は使わない
- 半透明を使わない。消える物は小さくするか、点滅させる
- 揺れも 1 ドット刻み

## 描き方

`g` は表示の canvas の 2D コンテキスト、`w` / `h` はその幅と高さ（px）。ゲームの座標（幅を 1）は、小さな画面では 90 倍する。

```javascript
// 絵のための乱数。引数だけで決まる。GF.rng() は絵に使わない
const hh = (n) => { const x = Math.sin(n * 127.1 + 11.7) * 43758.5453; return x - Math.floor(x); };

const LOW_W = 90, LOW_H = 160;
const low = document.createElement('canvas'); low.width = LOW_W; low.height = LOW_H;
const lg = low.getContext('2d');

// 四角を 1 つ。位置は丸める
function px(x, y, pw, ph, color) { lg.fillStyle = color; lg.fillRect(Math.round(x), Math.round(y), pw, ph); }

// スプライト。rows は文字の行、map は文字から色。'.' は透明
function sprite(rows, x, y, map) {
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < rows[j].length; i++) {
      const ch = rows[j][i];
      if (ch !== '.') px(x + i, y + j, 1, 1, map[ch]);
    }
  }
}

// 小さな画面を表示の canvas へ。毎フレームいちばん最後に呼ぶ
// （canvas の width を書き換えると imageSmoothingEnabled が戻るので、毎回 false にする）
function blit(g, w, h) { g.imageSmoothingEnabled = false; g.drawImage(low, 0, 0, w, h); }

// スプライトの例（7 × 7 の星）。W を Y と入れ替えると瞬く
const STAR = [
  '...Y...',
  '...Y...',
  'YYYYYYY',
  '.YYWYY.',
  '..YYY..',
  '.YY.YY.',
  '.Y...Y.',
];
// sprite(STAR, x, y, { Y: '#ffd23f', W: '#f2f0e6' });
```

`onDraw` の順番: `px(0, 0, LOW_W, LOW_H, 地の色)` → 遠景（星は `hh(i)` で位置を決めた 1 ドット）→ 地面 → 物 → 動かす物 → 粒 → `blit`。

点数などの文字は `blit` の後に、表示の canvas へ `monospace` で描く。影は同じ文字を右下に 1 ドットぶん（`w / 90`）ずらして暗い色で先に描く。

## 動き

- 瞬きや足踏みは `Math.floor(GF.frame / 10) % 2` でコマを切り替える
- 受けた、当たった瞬間に 2 × 2 の粒を 8 方向へ飛ばし、途中で 1 × 1 にして消す
- 揺れは、小さな画面に描く前に `lg.setTransform(1, 0, 0, 1, dx, dy)` で 1〜2 ドットずらす（`dx` / `dy` は整数。描き終えたら戻す）
- 動かす物は、動いている向きに目を 1 ドット寄せる
- 粒の位置などは `onTick` で持ち、`onDraw` は描くだけにする
