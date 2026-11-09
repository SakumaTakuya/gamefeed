import { describe, expect, it } from "vitest";
import { FORBIDDEN_IDENTIFIERS } from "../src/forbidden-identifiers.ts";
import {
  ACCEPTED_INPUTS,
  CODE_MAX_BYTES,
  DURATION_MAX,
  DURATION_MIN,
  FORBIDDEN_ELEMENTS,
  staticCheck,
  utf8ByteLength,
} from "../src/static-check.ts";

/** 契約を満たす最小の HTML。引数で meta と script を差し替える。 */
function html(opts: {
  title?: string | null;
  duration?: string | null;
  verb?: string | null;
  input?: string | null;
  target?: string | null;
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
${meta("gf:target", opts.target, "12")}
${opts.head ?? ""}
<style>body{margin:0}</style></head>
<body>${opts.body ?? '<div id="t"></div>'}
<script>${opts.script ?? "GF.onStart(() => {}); GF.onInput(() => { GF.score += 1; });"}</script>
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
    expect(r.meta).toEqual({
      title: "押せ",
      verb: "押せ！",
      input: "tap",
      duration: 300,
      target: 12,
    });
    expect(r.warnings).toEqual([]);
  });

  it("拒否結果のすべてのエラーに修正方法（fix）が含まれる", () => {
    const bad = html({
      duration: "999",
      verb: "",
      input: "tilt",
      target: "0",
      title: null,
      script: "fetch('x')",
      body: "<form></form>",
    });
    const errors = errorsOf(bad);
    expect(errors.length).toBeGreaterThanOrEqual(7);
    for (const e of errors) {
      expect(e.fix.length).toBeGreaterThan(0);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

describe("R-6.3-1 gf:duration", () => {
  it("R-6.3-1 範囲は 180〜600（gc#A.3。3〜10 秒）", () => {
    expect(DURATION_MIN).toBe(180);
    expect(DURATION_MAX).toBe(600);
  });

  it.each([
    ["180", true],
    ["600", true],
    ["179", false],
    ["601", false],
    ["480", true],
    ["abc", false],
    ["300.5", false],
    ["", false],
  ])("R-6.3-1 duration=%s → ok=%s", (v, ok) => {
    const r = staticCheck(html({ duration: v }));
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      const e = r.errors.find((x) => x.code === "META_DURATION");
      expect(e?.message).toContain("180〜600");
      expect(e?.fix).toContain("180〜600");
    }
  });

  it("R-6.3-1 範囲外の文言は 3〜10 秒", () => {
    const e = errorsOf(html({ duration: "601" })).find((x) => x.code === "META_DURATION");
    expect(e?.message).toContain("3〜10 秒");
  });

  it("R-6.3-1 欠落は拒否し、追加すべき meta タグを示す", () => {
    const errors = errorsOf(html({ duration: null }));
    const e = errors.find((x) => x.code === "META_DURATION");
    expect(e?.message).toContain("180〜600");
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
  it("R-6.3-3 受理する入力は tap / hold / swipe / drag / stick（gc#A.3）", () => {
    expect([...ACCEPTED_INPUTS]).toEqual(["tap", "hold", "swipe", "drag", "stick"]);
  });

  it.each(["tap", "hold", "swipe", "drag", "stick"])("R-6.3-3 input=%s を受理する", (v) => {
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

describe("R-gc.A3-1 gf:target", () => {
  it.each([
    ["1", true],
    ["12", true],
    ["0", false],
    ["-1", false],
    ["abc", false],
    ["1.5", false],
    ["", false],
  ])("R-gc.A3-1 target=%j → ok=%s", (v, ok) => {
    const r = staticCheck(html({ target: v }));
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      const e = r.errors.find((x) => x.code === "META_TARGET");
      expect(e?.fix).toContain("gf:target");
    }
  });

  it("R-gc.A3-1 欠落は META_TARGET で拒否し、追加すべき meta タグを示す", () => {
    const e = errorsOf(html({ target: null })).find((x) => x.code === "META_TARGET");
    expect(e?.message).toContain("gf:target");
    expect(e?.fix).toContain('<meta name="gf:target"');
  });

  it("R-gc.A3-1 Number で表せない桁数は拒否する", () => {
    expect(codesOf(html({ target: "9".repeat(400) }))).toContain("META_TARGET");
    expect(codesOf(html({ target: "9007199254740993" }))).toContain("META_TARGET");
  });

  it('R-gc.A3-1 script 内の文字列に書かれた <meta name="gf:target"> は宣言ではない', () => {
    const r = staticCheck(
      html({
        target: null,
        script: `const ex = '<meta name="gf:target" content="12">'; GF.score = 1;`,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("META_TARGET");
  });

  it('R-gc.A3-1 <textarea> など raw text 要素の中の <meta name="gf:target"> は宣言ではない', () => {
    for (const el of ["textarea", "xmp", "noembed", "noframes"]) {
      const r = staticCheck(
        html({ target: null, body: `<${el}><meta name="gf:target" content="12"></${el}>` }),
      );
      expect(r.ok, el).toBe(false);
      if (!r.ok)
        expect(
          r.errors.map((e) => e.code),
          el,
        ).toContain("META_TARGET");
    }
  });

  it('R-gc.A3-1 <template> の中の <meta name="gf:target"> は不活性なので宣言ではない', () => {
    const r = staticCheck(
      html({ target: null, body: '<template><meta name="gf:target" content="12"></template>' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("META_TARGET");
  });

  it('R-gc.A3-1 <title> の中の <meta name="gf:target"> は宣言ではない', () => {
    const r = staticCheck(
      html({
        title: null,
        target: null,
        head: '<title><meta name="gf:target" content="12"></title>',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("META_TARGET");
  });

  it("R-gc.A3-1 受理した target は meta に入る", () => {
    const r = staticCheck(html({ target: "7" }));
    expect(r.ok && r.meta.target).toBe(7);
  });
});

describe("R-gc.A2-1 使えない要素（gc#A.5）", () => {
  it.each(FORBIDDEN_ELEMENTS.map((e) => [e] as const))("R-gc.A2-1 <%s> は拒否する", (el) => {
    const r = staticCheck(html({ body: `<${el} id="x"></${el}>` }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.code === "FORBIDDEN_ELEMENT");
    expect(e?.message).toContain(`<${el}>`);
    expect(e?.line).toBeGreaterThan(0);
    expect(e?.fix.length).toBeGreaterThan(0);
  });

  it("R-gc.A2-1 大文字・自己終了・複数要素も 1 件にまとめる", () => {
    const r = staticCheck(html({ body: '<IFRAME src="#"></IFRAME><embed/><object></object>' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const es = r.errors.filter((x) => x.code === "FORBIDDEN_ELEMENT");
    expect(es).toHaveLength(1);
    expect(es[0]?.message).toContain("<iframe>");
    expect(es[0]?.message).toContain("<embed>");
    expect(es[0]?.message).toContain("<object>");
  });

  it("R-gc.A2-1 HTML コメントの中と似た名前（<formation>）は拒否しない", () => {
    expect(staticCheck(html({ body: "<!-- <form> --><formation></formation>" })).ok).toBe(true);
  });

  it("R-gc.A2-1 属性値に書かれた <form> は要素ではないので拒否しない", () => {
    expect(
      staticCheck(html({ body: `<div data-template="<form>" title='<iframe>'></div>` })).ok,
    ).toBe(true);
  });

  it('R-gc.A3-1 属性値に ">" を含む <meta> も読める', () => {
    const r = staticCheck(html({ verb: null, head: '<meta name="gf:verb" content="右へ>">' }));
    expect(r.ok && r.meta.verb).toBe("右へ>");
  });

  it("R-gc.A2-1 <textarea> / <template> / <noscript> / <title> の中に書かれた <form> は要素ではないので拒否しない", () => {
    expect(staticCheck(html({ body: "<textarea><form></form></textarea>" })).ok).toBe(true);
    expect(staticCheck(html({ body: "<template><form></form></template>" })).ok).toBe(true);
    expect(staticCheck(html({ body: "<noscript><form></form></noscript>" })).ok).toBe(true);
    const r = staticCheck(html({ title: "Demo <form>" }));
    expect(r.ok && r.meta.title).toBe("Demo <form>");
  });

  it("R-gc.A2-1 コード中の文字列に書かれた <form> は要素ではないので拒否しない", () => {
    expect(staticCheck(html({ script: "const s = '<form>'; GF.score = 1;" })).ok).toBe(true);
  });
});

describe("R-4.1-5 警告（拒否しない）", () => {
  const warningsOf = (h: string) => {
    const r = staticCheck(h);
    expect(r.ok).toBe(true);
    return r.warnings.map((w) => w.code);
  };

  it.each([
    "window.addEventListener('pointerdown', () => {}); GF.score = 1;",
    'document.addEventListener("touchstart", f); GF.score = 1;',
    "canvas.addEventListener(`keydown`, f); GF.score = 1;",
  ])("R-4.1-5 DIRECT_INPUT: %s", (script) => {
    expect(warningsOf(html({ script }))).toEqual(["DIRECT_INPUT"]);
  });

  it("R-4.1-5 DIRECT_INPUT: on* 属性（onpointerdown / onclick は mouse 系ではないので対象外）", () => {
    expect(warningsOf(html({ body: '<div onpointerdown="f()"></div>' }))).toEqual(["DIRECT_INPUT"]);
    expect(warningsOf(html({ body: '<div ontouchend="f()"></div>' }))).toEqual(["DIRECT_INPUT"]);
    expect(warningsOf(html({ body: '<div onload="f()"></div>' }))).toEqual([]);
  });

  it.each([
    "GF.onInput((ev) => { GF.score += 1; });",
    "// addEventListener('pointerdown') \n GF.score = 1;",
    "const name = 'pointerdown'; GF.score = 1;",
  ])("R-4.1-5 DIRECT_INPUT なし: %s", (script) => {
    expect(warningsOf(html({ script }))).toEqual([]);
  });

  it("R-4.1-5 DIRECT_INPUT は行番号を含む", () => {
    const r = staticCheck(
      html({ script: "GF.score = 1;\nwindow.addEventListener('mousedown', f);" }),
    );
    expect(r.ok && r.warnings[0]?.line).toBeGreaterThan(1);
  });

  it.each([
    "GF.onTick(() => {});",
    "const score = 3; GF.onTick(() => { score + 1; });",
    "GF.score; GF.onDraw(() => {});",
    "// GF.score = 1\nGF.onTick(() => {});",
    "const s = 'GF.end()'; GF.onTick(() => {});",
    "GF.onTick(() => { if (GF.score === 0) {} });",
    "GF.onTick(() => { if (GF.score == 0) {} });",
    "GF.onTick(() => { if (GF.score >= 10) {} });",
    "GF.onTick(() => { if (GF.score <= 10) {} });",
    "GF.onTick(() => { if (GF.score !== 0) {} });",
    "GF.onTick(() => { if (GF.score!=0) {} });",
  ])("R-4.1-5 NO_SCORE: %s", (script) => {
    expect(warningsOf(html({ script }))).toEqual(["NO_SCORE"]);
  });

  it.each([
    "GF.score = 1;",
    "GF.score += 1;",
    "GF.score++;",
    "++GF.score;",
    "GF.end();",
    "GF . score = 2;",
    "if (hit) GF.end()",
    "GF.score >>= 1;",
    "GF.score **= 2;",
    "GF.score ||= 0;",
    "GF.score &&= 1;",
    "GF.score ??= 0;",
  ])("R-4.1-5 NO_SCORE なし: %s", (script) => {
    expect(warningsOf(html({ script }))).toEqual([]);
  });

  it("R-4.1-5 VIEWPORT: 自分で viewport を書くと警告", () => {
    const r = staticCheck(html({ head: '<meta name="viewport" content="width=device-width">' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.map((w) => w.code)).toEqual(["VIEWPORT"]);
    expect(r.warnings[0]?.line).toBeGreaterThan(0);
  });

  it.each([
    "",
    '<meta name="description" content="x">',
    '<!-- <meta name="viewport" content="x"> -->',
  ])("R-4.1-5 VIEWPORT なし: %j", (head) => {
    expect(warningsOf(html({ head }))).toEqual([]);
  });

  it("R-4.1-5 警告は拒否と同時に返り、それぞれ fix を持つ", () => {
    const r = staticCheck(
      html({
        duration: "1",
        script: "window.addEventListener('keydown', f);",
        head: '<meta name="viewport" content="x">',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["DIRECT_INPUT", "NO_SCORE", "VIEWPORT"]);
    for (const w of r.warnings) expect(w.fix.length).toBeGreaterThan(0);
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
<meta name="gf:input" content="hold" /><meta name=gf:target content=3></head><body><script>GF.end()</script></body></html>`;
    const r = staticCheck(h);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.meta).toEqual({ title: "t", verb: "押せ", input: "hold", duration: 300, target: 3 });
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
