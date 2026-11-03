import { describe, expect, it } from "vitest";
import { FORBIDDEN_IDENTIFIERS } from "../src/forbidden-identifiers.ts";
import { CODE_MAX_BYTES, staticCheck, utf8ByteLength } from "../src/static-check.ts";

/** 契約を満たす最小の HTML。引数で meta と script を差し替える。 */
function html(opts: {
  title?: string | null;
  duration?: string | null;
  verb?: string | null;
  input?: string | null;
  script?: string;
  body?: string;
  head?: string;
}): string {
  const meta = (name: string, v: string | null | undefined, def: string) =>
    v === null ? "" : `<meta name="${name}" content="${v ?? def}">`;
  const title = opts.title === null ? "" : `<title>${opts.title ?? "押せ"}</title>`;
  return `<!doctype html><html><head>${title}
${meta("gf:duration", opts.duration, "300")}
${meta("gf:verb", opts.verb, "押せ！")}
${meta("gf:input", opts.input, "tap")}
${opts.head ?? ""}
<style>body{margin:0}</style></head>
<body>${opts.body ?? '<div id="t"></div>'}
<script>${opts.script ?? "GF.onStart(() => {}); GF.onInput(() => GF.win());"}</script>
</body></html>`;
}

function errorsOf(h: string) {
  const r = staticCheck(h);
  if (r.ok) throw new Error("expected reject");
  return r.errors;
}
function codesOf(h: string) {
  return errorsOf(h).map((e) => e.code);
}

describe("staticCheck 典型", () => {
  it("契約を満たす HTML を受理し、meta を返す", () => {
    const r = staticCheck(html({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toEqual({ title: "押せ", verb: "押せ！", input: "tap", duration: 300 });
    expect(r.warnings).toEqual([]);
  });

  it("拒否結果のすべてのエラーに修正方法（fix）が含まれる", () => {
    const bad = html({
      duration: "999",
      verb: "",
      input: "tilt",
      title: null,
      script: "fetch('x')",
    });
    const errors = errorsOf(bad);
    expect(errors.length).toBeGreaterThanOrEqual(5);
    for (const e of errors) {
      expect(e.fix.length).toBeGreaterThan(0);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

describe("R-6.3-1 gf:duration", () => {
  it.each([
    ["180", true],
    ["480", true],
    ["179", false],
    ["481", false],
    ["abc", false],
    ["300.5", false],
    ["", false],
  ])("R-6.3-1 duration=%s → ok=%s", (v, ok) => {
    const r = staticCheck(html({ duration: v }));
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      const e = r.errors.find((x) => x.code === "META_DURATION");
      expect(e?.message).toContain("180〜480");
    }
  });

  it("R-6.3-1 欠落は拒否し、追加すべき meta タグを示す", () => {
    const errors = errorsOf(html({ duration: null }));
    const e = errors.find((x) => x.code === "META_DURATION");
    expect(e?.message).toContain("180〜480");
    expect(e?.fix).toContain('<meta name="gf:duration"');
  });
});

describe("R-6.3-2 gf:verb", () => {
  it.each([
    ["押", true],
    ["押せ押せ押せ押せ", true],
    ["", false],
    ["押せ押せ押せ押せ押", false],
  ])("R-6.3-2 verb=%s → ok=%s", (v, ok) => {
    const r = staticCheck(html({ verb: v }));
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("META_VERB");
  });

  it("R-6.3-2 絵文字は見た目の 1 文字として数える（👍🏽×8 は受理、×9 は拒否）", () => {
    expect(staticCheck(html({ verb: "👍🏽".repeat(8) })).ok).toBe(true);
    expect(codesOf(html({ verb: "👍🏽".repeat(9) }))).toContain("META_VERB");
  });

  it("R-6.3-2 欠落は拒否する", () => {
    expect(codesOf(html({ verb: null }))).toContain("META_VERB");
  });
});

describe("R-6.3-3 gf:input", () => {
  it.each(["tap", "hold", "swipe"])("R-6.3-3 input=%s を受理する", (v) => {
    const r = staticCheck(html({ input: v }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.input).toBe(v);
  });

  it("R-6.3-3 tilt は MVP では拒否し、その旨を伝える", () => {
    const e = errorsOf(html({ input: "tilt" })).find((x) => x.code === "META_INPUT");
    expect(e?.message).toContain("tilt");
    expect(e?.fix).toMatch(/tap|hold|swipe/);
  });

  it.each(["", "TAP", "tap swipe", "click"])("R-6.3-3 input=%j は拒否する", (v) => {
    expect(codesOf(html({ input: v }))).toContain("META_INPUT");
  });

  it("R-6.3-3 欠落は拒否する", () => {
    expect(codesOf(html({ input: null }))).toContain("META_INPUT");
  });
});

describe("R-4.1-1 サイズ上限", () => {
  it("R-4.1-1 上限は 128 KiB（gzip 前、UTF-8 バイト数）", () => {
    expect(CODE_MAX_BYTES).toBe(128 * 1024);
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("あ")).toBe(3);
    expect(utf8ByteLength("👍")).toBe(4);
    expect(utf8ByteLength("é")).toBe(2);
  });

  it("R-4.1-1 ちょうど上限は受理し、1 バイト超は拒否する", () => {
    const base = html({ body: "" });
    const baseBytes = utf8ByteLength(base);
    const pad = "x".repeat(CODE_MAX_BYTES - baseBytes);
    const exact = html({ body: pad });
    expect(utf8ByteLength(exact)).toBe(CODE_MAX_BYTES);
    expect(staticCheck(exact).ok).toBe(true);
    const over = html({ body: `${pad}x` });
    const e = errorsOf(over).find((x) => x.code === "SIZE");
    expect(e?.message).toContain("128");
  });

  it("R-4.1-1 日本語はバイト数で数える（文字数ではない）", () => {
    const base = html({ body: "" });
    const baseBytes = utf8ByteLength(base);
    // 「あ」は 3 バイト。1 文字あたりの余裕を超えるぶんだけ入れると拒否される
    const n = Math.ceil((CODE_MAX_BYTES - baseBytes) / 3) + 1;
    expect(codesOf(html({ body: "あ".repeat(n) }))).toContain("SIZE");
  });
});

describe("R-4.1-2 禁止識別子", () => {
  // データファイルの各項目が、少なくとも代表例で検出されること。項目を足したらここにも足す
  const samples: Record<string, string> = {
    fetch: "fetch('./assets/a.png')",
    XMLHttpRequest: "new XMLHttpRequest()",
    WebSocket: "new WebSocket('wss://x')",
    EventSource: "new EventSource('/e')",
    "navigator.sendBeacon": "navigator.sendBeacon('/x', '')",
    "import(": "import('./m.js')",
    eval: "eval('1')",
    "new Function": "new Function('return 1')",
    "document.cookie": "document.cookie",
    localStorage: "localStorage.setItem('a', 1)",
    indexedDB: "indexedDB.open('db')",
    "open(": "open('https://x')",
    "location =": "location = 'https://x'",
    "Math.random": "Math.random()",
    "Date.now": "Date.now()",
    "performance.now": "performance.now()",
    setTimeout: "setTimeout(() => {}, 1)",
    setInterval: "setInterval(() => {}, 1)",
    requestAnimationFrame: "requestAnimationFrame(() => {})",
  };

  it("R-4.1-2 データファイルの全項目にテスト例がある", () => {
    for (const f of FORBIDDEN_IDENTIFIERS) {
      expect(samples, `${f.name} のテスト例が無い`).toHaveProperty(f.name);
    }
    expect(Object.keys(samples).length).toBe(FORBIDDEN_IDENTIFIERS.length);
  });

  it.each(Object.entries(samples))("R-4.1-2 %s を検出し、代替手段を示す", (name, code) => {
    const e = errorsOf(html({ script: code })).find((x) => x.code === "FORBIDDEN_API");
    expect(e, `${name} が検出されない`).toBeDefined();
    expect(e?.message).toContain(name);
    expect(e?.fix.length).toBeGreaterThan(0);
  });

  it.each([
    ["location.href = 'x'", true],
    ["window.location = 'x'", true],
    ["location.assign('x')", true],
    ["location.replace('x')", true],
    ["if (location === a) {}", false],
    ["const h = location.hash", false],
  ])("R-4.1-2 location: %s → 拒否=%s", (code, rejected) => {
    expect(!staticCheck(html({ script: code })).ok).toBe(rejected);
  });

  it.each([
    ["const fetched = 1", "識別子の一部"],
    ["const x = 'call fetch here'", "文字列リテラル"],
    ["// fetch は使わない", "行コメント"],
    ["/* no\n fetch */", "ブロックコメント"],
    ["obj.fetch()", "プロパティ名"],
    ["GF.rng()", "SDK の代替"],
    ["Math.floor(1.5)", "Math の他のメソッド"],
    ["new Date(0)", "Date コンストラクタ"],
    ["canvas.open()", "他オブジェクトの open"],
    ["doc.cookieJar", "document.cookie の部分一致"],
  ])("R-4.1-2 誤検出しない: %s（%s）", (code) => {
    expect(staticCheck(html({ script: code })).ok).toBe(true);
  });

  it("R-4.1-2 複数の script と on* 属性も検査する", () => {
    const h = html({
      body: `<button onclick="fetch('x')">a</button><script>Math.random()</script>`,
    });
    const names = errorsOf(h)
      .filter((e) => e.code === "FORBIDDEN_API")
      .map((e) => e.message);
    expect(names.some((m) => m.includes("fetch"))).toBe(true);
    expect(names.some((m) => m.includes("Math.random"))).toBe(true);
  });

  it("R-4.1-2 同じ識別子が複数回あっても 1 件にまとめ、行番号を含む", () => {
    const errors = errorsOf(html({ script: "fetch('a');\nfetch('b');" })).filter(
      (e) => e.code === "FORBIDDEN_API",
    );
    expect(errors.length).toBe(1);
    expect(errors[0]?.line).toBeGreaterThan(0);
  });
});

describe("R-4.1-3 title", () => {
  it("R-4.1-3 <title> が無ければ拒否する", () => {
    expect(codesOf(html({ title: null }))).toContain("META_TITLE");
  });
  it("R-4.1-3 空白だけの <title> は拒否する", () => {
    expect(codesOf(html({ title: "   " }))).toContain("META_TITLE");
  });
  it("R-4.1-3 title の前後の空白は取り除く", () => {
    const r = staticCheck(html({ title: "  押せ  " }));
    expect(r.ok && r.meta.title).toBe("押せ");
  });
});

describe("R-4.1-4 読み込み先の制限", () => {
  it.each([
    `<img src="./assets/a.png">`,
    `<script src="/lib/three@0.160.0.min.js"></script>`,
    `<a href="#top">x</a>`,
    `<style>.a{background:url(./assets/bg.png)}</style>`,
    `<style>.a{background:url("./assets/bg.png")}</style>`,
    `<svg><use href="#icon"/></svg>`,
  ])("R-4.1-4 受理: %s", (frag) => {
    expect(staticCheck(html({ body: frag })).ok).toBe(true);
  });

  it.each([
    `<img src="https://example.com/a.png">`,
    `<img src="data:image/png;base64,AAAA">`,
    `<script src="https://cdn.example/x.js"></script>`,
    `<script src="/lib/three.js"></script>`,
    `<link rel="stylesheet" href="https://x/y.css">`,
    `<img src="../other/a.png">`,
    `<img src="/p/other/assets/a.png">`,
    `<style>.a{background:url(https://x/bg.png)}</style>`,
    `<style>@import url("https://x/y.css");</style>`,
    `<audio src="data:audio/mp3;base64,AAAA"></audio>`,
  ])("R-4.1-4 拒否: %s", (frag) => {
    const e = errorsOf(html({ body: frag })).find((x) => x.code === "EXTERNAL_REF");
    expect(e).toBeDefined();
    expect(e?.fix).toContain("./assets/");
  });
});

describe("入力の前提", () => {
  it("<meta> の属性順や引用符の違いを許容する", () => {
    const h = `<!doctype html><html><head><title>t</title>
<meta content='300' name='gf:duration'>
<meta name=gf:verb content=押せ>
<meta name="gf:input" content="hold" /></head><body><script>GF.win()</script></body></html>`;
    const r = staticCheck(h);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta).toEqual({ title: "t", verb: "押せ", input: "hold", duration: 300 });
  });

  it("エラーは code / message / fix を持ち、message は日本語で読める", () => {
    const e = errorsOf(html({ duration: "1" }))[0];
    expect(e).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      fix: expect.any(String),
    });
  });
});
