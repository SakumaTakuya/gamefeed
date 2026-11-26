# 画風カード: ネオン（`neon`）

暗い地に、光だけで描く絵。物の形は線と点の発光で見せ、色は重なると明るくなる。

## 配色

| 役 | 色 |
| --- | --- |
| 地 | `#070512` から `#22093c` へ（上から下） |
| 取る物、味方 | `#7df9ff`（RGB `125,249,255`） |
| 動かす物 | `#ff3df0` |
| 危険、失敗 | `#ff3b6b` |
| 飾り（床の格子、遠景） | `#ff3cd2` を半透明で |
| 芯、文字 | `#ffffff` |

光の色は 3 色まで。役（取る物 / 動かす物 / 危険）ごとに色を決め、ゲームの中で変えない。

## 決まり

- 地は暗いまま残す。画面の半分以上を光で埋めない
- 光る物は加算（`globalCompositeOperation = 'lighter'`）で描く
- 線は「色つきの太い線」の上に「白い細い芯」を重ねる。面で塗りつぶさない
- 動く物は尾を引く。尾は進む向きの反対に伸び、先で消える
- 飾りは操作する物より暗くする
- 最後に走査線を全面に重ねる

## 描き方

`g` は canvas の 2D コンテキスト、`w` / `h` は canvas の幅と高さ（px）。

```javascript
// 絵のための乱数。引数だけで決まる。GF.rng() は絵に使わない
const hh = (n) => { const x = Math.sin(n * 127.1 + 11.7) * 43758.5453; return x - Math.floor(x); };

// 光は加算で重ねる。lit(g, () => { ...光る物を描く... })
function lit(g, draw) { g.save(); g.globalCompositeOperation = 'lighter'; draw(); g.restore(); }

// ネオン管の線。pts は [[x, y], ...]（px）
function glowLine(g, w, pts, color, width) {
  g.lineCap = g.lineJoin = 'round';
  g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  g.shadowColor = color; g.shadowBlur = 0.06 * w; g.strokeStyle = color; g.lineWidth = width; g.stroke();
  g.shadowBlur = 0; g.strokeStyle = '#fff'; g.lineWidth = width * 0.28; g.stroke();
}

// 光の玉。rgb は '125,249,255' の形。(tx, ty) は尾の向きと長さ（px）。落ちる物なら (0, -速さ * 11)
function orb(g, x, y, r, rgb, tx, ty) {
  if (tx || ty) {
    const t = g.createLinearGradient(x + tx, y + ty, x, y);
    t.addColorStop(0, 'rgba(' + rgb + ',0)'); t.addColorStop(1, 'rgba(' + rgb + ',.75)');
    g.strokeStyle = t; g.lineWidth = r * 1.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x + tx, y + ty); g.lineTo(x, y); g.stroke();
  }
  const halo = g.createRadialGradient(x, y, 0, x, y, r * 4);
  halo.addColorStop(0, 'rgba(' + rgb + ',.9)'); halo.addColorStop(1, 'rgba(' + rgb + ',0)');
  g.fillStyle = halo; g.beginPath(); g.arc(x, y, r * 4, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}

// 広がって消える輪。u は 0（出た瞬間）から 1（消える）
function ring(g, w, x, y, u, color) {
  g.globalAlpha = 1 - u; g.strokeStyle = color; g.lineWidth = 0.014 * w * (1 - u) + 1;
  g.beginPath(); g.arc(x, y, (0.03 + u * 0.22) * w, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
}

// 奥へ伸びる床の格子。hz は地平線の高さ（px）。frame で手前に流れる
function gridFloor(g, w, h, hz, frame) {
  g.strokeStyle = 'rgba(255,60,210,.55)'; g.lineWidth = Math.max(1, 0.004 * w);
  g.shadowColor = '#ff3cd2'; g.shadowBlur = 0.02 * w;
  g.beginPath();
  for (let i = -9; i <= 9; i++) { g.moveTo(w / 2 + i * 0.028 * w, hz); g.lineTo(w / 2 + i * 0.26 * w, h); }
  const ph = (frame * 0.02) % 1;
  for (let i = 0; i < 9; i++) { const u = (i + ph) / 9, y = hz + (h - hz) * u * u; g.moveTo(0, y); g.lineTo(w, y); }
  g.moveTo(0, hz); g.lineTo(w, hz); g.stroke(); g.shadowBlur = 0;
}

// 走査線。1 回だけ作り、毎フレームいちばん最後に重ねる
let scan = null;
function scanlines(g, w, h) {
  if (!scan) {
    scan = document.createElement('canvas'); scan.width = 2; scan.height = 3;
    const c = scan.getContext('2d'); c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(0, 2, 2, 1);
  }
  g.fillStyle = g.createPattern(scan, 'repeat'); g.fillRect(0, 0, w, h);
}
```

`onDraw` の順番: 地のグラデーション → 遠景（星は `hh(i)` で位置を決めた小さな点）→ `lit` の中で床・物・動かす物・輪 → 文字 → `scanlines`。

文字は同じ文字を 3 回描く: 左に 2 px ずらして `#ff3df0`、右に 2 px ずらして `#19e6ff`（どちらも加算）、最後に白。

## 動き

- 受けた、当たった瞬間に `ring` を 1 つ出し、短い線の火花を 10 本ほど飛ばす（線は速度の向きに伸ばす）
- 同じ瞬間に画面全体を白で 1〜2 フレームだけ薄く光らせる（`rgba(255,255,255,.15)` 以下）
- 動かす物は、受けた瞬間に線を太くし、光を強くして戻す
- 粒は「出てからのフレーム数」から位置を計算すると、状態を足さずに描ける（`x = x0 + vx * age`、`y = y0 + vy * age + 重力 * age * age`。速度は `hh(seed + i)` で決める）。`onTick` で持つなら、`onDraw` は描くだけにする
