# 画風カード: 切り絵（`kirie`）

色紙を切って重ねた絵。色は面で塗り、線は引かない。紙の重なりを影で見せる。

## 配色

| 役 | 色 |
| --- | --- |
| 空（いちばん奥の紙） | `#2c6170` |
| 遠景・中景・近景 | `#3f8376` / `#2f6a60` / `#22504a` |
| 地面 | `#1b3f3b` |
| 明るい紙（月、雲、文字） | `#f3e3b0` / `#d9e6df` |
| 主役（取る物、動かす物） | `#f08a24` / `#f7b14a` / `#b9814a` |
| 差し色 | `#5f8f3e` |

題材に合わせて変えてよい。紙は 8 色まで。主役は地から浮く色にし、背景の紙は主役より暗くする。

## 決まり

- 輪郭線を引かない。形は `fill` だけで描く
- 1 枚の紙は 1 色。グラデーションを使わない
- 重なる紙ごとに影を落とす。影の向き（下）と濃さはどの紙も同じ
- 切り口を少し不揃いにする。ずれは物ごとに固定する（毎フレーム変えると震えて紙に見えない）
- 最後に紙目を全面に重ねる
- 文字も紙として描く。太い書体に影を付ける

## 描き方

`g` は canvas の 2D コンテキスト、`w` / `h` は canvas の幅と高さ（px）。大きさは `w` に対する比で決める。

```javascript
// 絵のための乱数。引数だけで決まる。GF.rng() は絵に使わない
const hh = (n) => { const x = Math.sin(n * 127.1 + 11.7) * 43758.5453; return x - Math.floor(x); };

// 紙の影。紙を描く前に paperShadow(g, w, true)、描いたら false に戻す
function paperShadow(g, w, on) {
  g.shadowColor = on ? 'rgba(8,22,26,.42)' : 'transparent';
  g.shadowBlur = on ? 0.022 * w : 0;
  g.shadowOffsetX = 0;
  g.shadowOffsetY = on ? 0.011 * w : 0;
}

// 切り口の不揃いな丸。seed は物ごとに固定の数。n は角の数（大きな丸は 24 ほどに増やす）
function cutBlob(g, x, y, r, seed, n = 11) {
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, rr = r * (0.9 + hh(seed + i * 5.3) * 0.2);
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
}

// 紙の山。base は稜線の高さ（px）、amp は起伏（px）。奥から手前へ、暗い色で 3 枚重ねる
function cutHill(g, w, h, base, amp, seed, color) {
  g.fillStyle = color;
  g.beginPath(); g.moveTo(-0.1 * w, h * 1.1);
  for (let i = -2; i <= 34; i++) {
    const x = i / 32 * w;
    g.lineTo(x, base + Math.sin(i * 0.3 + seed) * amp + (hh(i * 1.3 + seed * 9) - 0.5) * 0.014 * w);
  }
  g.lineTo(1.1 * w, h * 1.1); g.closePath(); g.fill();
}

// 紙目。1 回だけ作り、毎フレームいちばん最後に重ねる
let grain = null;
function paperGrain(g, w, h) {
  if (!grain) {
    grain = document.createElement('canvas'); grain.width = grain.height = 128;
    const c = grain.getContext('2d'), im = c.createImageData(128, 128);
    for (let i = 0; i < 128 * 128; i++) {
      const v = hh(i * 0.37) < 0.5 ? 0 : 255;
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
      im.data[i * 4 + 3] = hh(i * 0.91 + 3) * 15;
    }
    c.putImageData(im, 0, 0);
  }
  g.fillStyle = g.createPattern(grain, 'repeat'); g.fillRect(0, 0, w, h);
}
```

`onDraw` の順番: 空を塗る → `paperShadow(on)` → 奥の紙から手前へ → 主役 → `paperShadow(off)` → 文字 → `paperGrain`。

## 動き

- 落ちる物、飛ぶ物はゆっくり回す
- 受けた、当たった瞬間は、受けた側を潰して戻す（縦 0.8 倍・横 1.15 倍から数フレームで 1 倍へ）
- 紙吹雪: 小さな四角を 10 枚ほど散らし、横幅に `Math.cos(残りフレーム * 0.35)` を掛けて裏返って見せる
- 背景の紙は、動かす物の位置に合わせて奥ほど小さくずらす（奥行きが出る）
- 粒は「出てからのフレーム数」から位置を計算すると、状態を足さずに描ける（`x = x0 + vx * age`、`y = y0 + vy * age + 重力 * age * age`。速度は `hh(seed + i)` で決める）。`onTick` で持つなら、`onDraw` は描くだけにする
