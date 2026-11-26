# 画風カード: 黒板（`kokuban`）

黒板にチョークで描いた絵。全部を震える線で描き、面は塗らない。

## 配色

| 役 | 色 |
| --- | --- |
| 黒板 | `#22382e` |
| 白チョーク（動かす物、枠、文字） | `#f4f4ec` |
| 黄チョーク（取る物、点数） | `#ffe27a` |
| 赤チョーク（失敗、危険） | `#ff9d9d` |
| 緑チョーク（残り時間など） | `#9fe0b4` |
| 粉受け（画面の下の木） | `#8a6844` / `#6f5234` |

チョークは 4 色まで。白を基本にし、色は意味のある物にだけ使う。

## 決まり

- 物は線だけで描く。塗るなら同じ色を薄く（不透明度 0.2 まで）
- 線はまっすぐ引かない。点ごとに少しずらし、太さの違う線を 2 回重ねる
- 線の震えを数フレームごとに引き直す（手描きのアニメーションに見える）。毎フレーム変えない
- 黒板は均一に塗らない。消し跡と粉を重ねる
- 数は数字より、書いて増える印で見せる（「正」の字、丸、線）
- 顔を描くと物が生きる（点 2 つと弧 1 本で足りる）

## 描き方

`g` は canvas の 2D コンテキスト、`w` / `h` は canvas の幅と高さ（px）。

```javascript
// 絵のための乱数。引数だけで決まる。GF.rng() は絵に使わない
const hh = (n) => { const x = Math.sin(n * 127.1 + 11.7) * 43758.5453; return x - Math.floor(x); };

// チョークの線。pts は [[x, y], ...]（px）。seed が同じなら同じ震え
// 動く物には seed に boil を足す:  const boil = Math.floor(GF.frame / 7) * 13.7;
function chalk(g, w, pts, color, width, seed, closed) {
  const j = 0.007 * w;
  for (let pass = 0; pass < 2; pass++) {
    g.beginPath();
    pts.forEach((p, i) => {
      const x = p[0] + (hh(seed + i * 3.1 + pass * 17) - 0.5) * j;
      const y = p[1] + (hh(seed + i * 5.9 + pass * 29) - 0.5) * j;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    if (closed) g.closePath();
    g.strokeStyle = color; g.globalAlpha = pass ? 0.4 : 0.9;
    g.lineWidth = width * (pass ? 1.9 : 1); g.lineCap = g.lineJoin = 'round';
    g.setLineDash([(7 + hh(seed) * 6) * w / 360, 1.3 * w / 360, 4 * w / 360, 0.9 * w / 360]);
    g.lineDashOffset = hh(seed + pass) * 20;
    g.stroke();
  }
  g.setLineDash([]); g.globalAlpha = 1;
}

// 黒板。消し跡と粉は 1 回だけ作る。毎フレーム最初に呼ぶ
let board = null;
function blackboard(g, w, h) {
  if (!board) {
    board = document.createElement('canvas'); board.width = 360; board.height = 640;
    const c = board.getContext('2d'); c.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      c.strokeStyle = 'rgba(255,255,255,' + (0.01 + hh(i) * 0.02) + ')'; c.lineWidth = 18 + hh(i + 0.1) * 46;
      const x = hh(i + 0.2) * 360, y = hh(i + 0.3) * 640, a = (hh(i + 0.4) - 0.5) * 0.6, l = 60 + hh(i + 0.5) * 160;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
    }
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = 'rgba(255,255,255,' + hh(i * 0.7) * 0.09 + ')'; c.fillRect(hh(i * 1.1) * 360, hh(i * 1.3) * 640, 1, 1);
    }
  }
  g.fillStyle = '#22382e'; g.fillRect(0, 0, w, h); g.drawImage(board, 0, 0, w, h);
}

// 「正」の字で n を数える。(x, y) は左上、size は 1 文字の大きさ（px）
const SEI = [[2, 3, 18, 3], [10, 3, 10, 17], [10, 10, 16, 10], [5, 9, 5, 17], [1, 17, 19, 17]];
function tally(g, w, x, y, size, n, color) {
  const k = size / 20;
  for (let i = 0; i < n; i++) {
    const s = SEI[i % 5], gx = x + Math.floor(i / 5) * size * 1.15;
    chalk(g, w, [[gx + s[0] * k, y + s[1] * k], [gx + s[2] * k, y + s[3] * k]], color, 0.008 * w, i * 7.7);
  }
}
```

物の描き方: 輪郭の点の列を作って `chalk(..., closed = true)`。星なら 10 点、丸なら 14 点ほどで足りる。点が少ないほど手描きに見える。

`onDraw` の順番: `blackboard` → 粉受け（下端の木の帯とチョークの欠片）→ 残る跡（失敗の ×）→ 物 → 動かす物 → 粉 → `tally`。

## 動き

- 動く物の `seed` に `boil`（上のコメント）を足して、線を 7 フレームごとに引き直す。黒板に残る跡や枠には足さない
- 落ちる物には、上に短い線を 2 本添えて速さを見せる
- 受けた、当たった瞬間に粉を出す: 1〜3 px の点を 15 個ほど、ゆっくり落として消す
- 失敗は跡で残す（赤チョークの ×）。消さない
- 粉の位置などは `onTick` で持ち、`onDraw` は描くだけにする
