// publish_game が受け取る HTML の静的解析（spec#4.1, spec#4.4, spec#6.3, spec#9）。
// 字句レベルの検査で、難読化は見抜かない。本当の防御線はサンドボックス（spec#5）。
// 役割は、善意の作者が契約に合わないゲームを投稿するのを防ぎ、直し方を伝えること。

import { FORBIDDEN_IDENTIFIERS } from "./forbidden-identifiers.ts";
import type { GameMeta, InputKind } from "./session.ts";

/** コードの上限（gzip 前、UTF-8 バイト数）。spec#4.1 */
export const CODE_MAX_BYTES = 128 * 1024;
/** gf:duration の範囲（論理フレーム）。spec#6.3 */
export const DURATION_MIN = 180;
export const DURATION_MAX = 480;
/** gf:verb の長さ（書記素クラスタ数）。spec#6.3 */
export const VERB_MAX_CHARS = 8;
/** MVP で受理する入力種別。tilt は spec#6.3 により拒否 */
export const ACCEPTED_INPUTS: readonly InputKind[] = ["tap", "hold", "swipe"];

export type FindingCode =
  | "SIZE"
  | "META_TITLE"
  | "META_DURATION"
  | "META_VERB"
  | "META_INPUT"
  | "FORBIDDEN_API"
  | "EXTERNAL_REF";

export interface Finding {
  code: FindingCode;
  /** 何が問題か。作者（と作者を使う AI）が読む日本語 */
  message: string;
  /** どう直せばよいか。空にしない（spec#9） */
  fix: string;
  /** 最初に見つかった行（1 始まり）。位置が特定できるものだけ */
  line?: number;
}

export type StaticCheckResult =
  | { ok: true; meta: GameMeta; warnings: Finding[] }
  | { ok: false; errors: Finding[]; warnings: Finding[] };

/** UTF-8 でのバイト数。TextEncoder に依存しない（domain は lib を持たない） */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

export function staticCheck(html: string): StaticCheckResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  checkSize(html, errors);
  const title = checkTitle(html, errors);
  const metas = readMetas(html);
  const duration = checkDuration(metas.get("gf:duration"), errors);
  const verb = checkVerb(metas.get("gf:verb"), errors);
  const input = checkInput(metas.get("gf:input"), errors);
  checkForbiddenIdentifiers(html, errors);
  checkExternalRefs(html, errors);

  if (
    errors.length > 0 ||
    title === undefined ||
    duration === undefined ||
    verb === undefined ||
    input === undefined
  ) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, meta: { title, verb, input, duration }, warnings };
}

function checkSize(html: string, errors: Finding[]): void {
  const bytes = utf8ByteLength(html);
  if (bytes > CODE_MAX_BYTES) {
    errors.push({
      code: "SIZE",
      message: `index.html が ${bytes} バイトあり、上限の ${CODE_MAX_BYTES} バイト（128 KB）を超えています。`,
      fix: "画像・音声・フォントは data: URI にせずアセット（./assets/）に分けてください。コードはコメントや未使用の部分を削ると小さくなります。",
    });
  }
}

function checkTitle(html: string, errors: Finding[]): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = m?.[1]?.trim();
  if (!title) {
    errors.push({
      code: "META_TITLE",
      message: "<title> がありません（または空です）。",
      fix: "<head> に <title>ゲーム名</title> を入れてください。",
    });
    return undefined;
  }
  return title;
}

/** `<meta name=... content=...>` を name → content の表にする。属性の順序と引用符の有無を問わない */
function readMetas(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = readAttrs(tag);
    const name = attrs.get("name");
    const content = attrs.get("content");
    if (name !== undefined && content !== undefined && !out.has(name)) out.set(name, content);
  }
  return out;
}

const ATTR_RE = /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function readAttrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(ATTR_RE)) {
    const key = m[1]?.toLowerCase();
    if (key === undefined) continue;
    out.set(key, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const DURATION_FIX = `<head> に <meta name="gf:duration" content="300"> のように、${DURATION_MIN}〜${DURATION_MAX} の整数（フレーム数。60 フレーム = 1 秒）を書いてください。`;

function checkDuration(raw: string | undefined, errors: Finding[]): number | undefined {
  const range = `${DURATION_MIN}〜${DURATION_MAX}`;
  if (raw === undefined) {
    errors.push({
      code: "META_DURATION",
      message: `gf:duration がありません。ゲームの長さは ${range} フレームの範囲で宣言が必要です。`,
      fix: DURATION_FIX,
    });
    return undefined;
  }
  const t = raw.trim();
  if (!/^\d+$/.test(t)) {
    errors.push({
      code: "META_DURATION",
      message: `gf:duration の値「${raw}」は整数ではありません。${range} の整数を指定してください。`,
      fix: DURATION_FIX,
    });
    return undefined;
  }
  const n = Number(t);
  if (n < DURATION_MIN || n > DURATION_MAX) {
    errors.push({
      code: "META_DURATION",
      message: `gf:duration の値 ${n} は範囲外です。${range} フレーム（3〜8 秒）にしてください。`,
      fix: DURATION_FIX,
    });
    return undefined;
  }
  return n;
}

function graphemeCount(s: string): number {
  const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
}

const VERB_FIX = `<head> に <meta name="gf:verb" content="押せ！"> のように、1〜${VERB_MAX_CHARS} 文字の命令形を書いてください。幕間に大きく表示されます。`;

function checkVerb(raw: string | undefined, errors: Finding[]): string | undefined {
  if (raw === undefined) {
    errors.push({ code: "META_VERB", message: "gf:verb がありません。", fix: VERB_FIX });
    return undefined;
  }
  const verb = raw.trim();
  const len = graphemeCount(verb);
  if (len === 0) {
    errors.push({ code: "META_VERB", message: "gf:verb が空です。", fix: VERB_FIX });
    return undefined;
  }
  if (len > VERB_MAX_CHARS) {
    errors.push({
      code: "META_VERB",
      message: `gf:verb「${verb}」は ${len} 文字で、上限の ${VERB_MAX_CHARS} 文字を超えています。`,
      fix: VERB_FIX,
    });
    return undefined;
  }
  return verb;
}

const INPUT_FIX = `<head> に <meta name="gf:input" content="tap"> のように、${ACCEPTED_INPUTS.join(" / ")} のいずれか 1 つを書いてください。`;

function checkInput(raw: string | undefined, errors: Finding[]): InputKind | undefined {
  if (raw === undefined) {
    errors.push({ code: "META_INPUT", message: "gf:input がありません。", fix: INPUT_FIX });
    return undefined;
  }
  const v = raw.trim();
  if (v === "tilt") {
    errors.push({
      code: "META_INPUT",
      message: "gf:input の tilt（傾き）は現在受け付けていません。",
      fix: INPUT_FIX,
    });
    return undefined;
  }
  const hit = ACCEPTED_INPUTS.find((k) => k === v);
  if (hit === undefined) {
    errors.push({
      code: "META_INPUT",
      message: `gf:input の値「${raw}」は使えません。`,
      fix: INPUT_FIX,
    });
    return undefined;
  }
  return hit;
}

/** 検査対象のコード片（script の中身と on* 属性の値）。行番号は HTML 全体での位置 */
interface CodeChunk {
  code: string;
  /** HTML 全体でのオフセット（行番号計算用） */
  offset: number;
}

function collectCode(html: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m.index === undefined) continue;
    chunks.push({ code: m[1] ?? "", offset: m.index + m[0].indexOf(m[1] ?? "") });
  }
  // on* 属性（inline handler）
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    if (tag.index === undefined || /^<script\b/i.test(tag[0])) continue;
    for (const a of tag[0].matchAll(/\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const v = a[1] ?? a[2] ?? a[3] ?? "";
      chunks.push({ code: v, offset: tag.index + (a.index ?? 0) });
    }
  }
  return chunks;
}

/**
 * コメントと文字列リテラルを同じ長さの空白に置き換える（行番号を保つ）。
 * テンプレートリテラルの ${} の中身は検査しない（割り切り。spec#4.4）。
 */
export function blankCommentsAndStrings(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = code[i] as string;
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += blank(code.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(code.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && code[j] !== c) {
        if (code[j] === "\\") j++;
        else if (c !== "`" && code[j] === "\n") break;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += blank(code.slice(i, stop));
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function checkForbiddenIdentifiers(html: string, errors: Finding[]): void {
  const seen = new Map<string, Finding>();
  for (const chunk of collectCode(html)) {
    const code = blankCommentsAndStrings(chunk.code);
    for (const f of FORBIDDEN_IDENTIFIERS) {
      if (seen.has(f.name)) continue;
      const m = f.pattern.exec(code);
      if (!m) continue;
      const line = lineAt(html, chunk.offset + m.index);
      seen.set(f.name, {
        code: "FORBIDDEN_API",
        message: `${f.name}: ${f.reason}`,
        fix: f.fix,
        line,
      });
    }
  }
  errors.push(...seen.values());
}

const ASSET_RE = /^\.\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LIB_RE = /^\/lib\/[A-Za-z0-9][A-Za-z0-9._-]*@[0-9][A-Za-z0-9.+-]*\.min\.js$/;

function isAllowedRef(value: string): boolean {
  const v = value.trim();
  if (v === "" || v.startsWith("#")) return true;
  return ASSET_RE.test(v) || LIB_RE.test(v);
}

const EXTERNAL_FIX =
  "画像・音声・フォントは投稿のアセットに入れて ./assets/<name> で参照し、ライブラリは /lib/<name>@<version>.min.js（ホワイトリスト）から読み込んでください。外部 URL と data: URI は使えません。";

function checkExternalRefs(html: string, errors: Finding[]): void {
  const bad: { value: string; where: string; offset: number }[] = [];
  // 要素の src / href / xlink:href 属性
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    if (tag.index === undefined) continue;
    for (const a of tag[0].matchAll(ATTR_RE)) {
      const key = a[1]?.toLowerCase();
      if (key !== "src" && key !== "href" && key !== "xlink:href") continue;
      const v = a[2] ?? a[3] ?? a[4] ?? "";
      if (!isAllowedRef(v))
        bad.push({ value: v, where: `${key} 属性`, offset: tag.index + (a.index ?? 0) });
    }
  }
  // CSS の url() と @import（<style> と style 属性）
  const cssSources: { css: string; offset: number }[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (m.index !== undefined) cssSources.push({ css: m[1] ?? "", offset: m.index });
  }
  for (const m of html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (m.index !== undefined) cssSources.push({ css: m[1] ?? m[2] ?? "", offset: m.index });
  }
  for (const { css, offset } of cssSources) {
    for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi)) {
      const v = m[1] ?? m[2] ?? m[3] ?? "";
      if (!isAllowedRef(v))
        bad.push({ value: v, where: "CSS の url()", offset: offset + (m.index ?? 0) });
    }
    for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi)) {
      const v = m[1] ?? m[2] ?? "";
      if (!isAllowedRef(v))
        bad.push({ value: v, where: "CSS の @import", offset: offset + (m.index ?? 0) });
    }
  }
  if (bad.length === 0) return;
  const first = bad[0] as (typeof bad)[number];
  const list = bad
    .slice(0, 5)
    .map((b) => `${b.where} の「${b.value.length > 60 ? `${b.value.slice(0, 60)}…` : b.value}」`)
    .join("、");
  errors.push({
    code: "EXTERNAL_REF",
    message: `許可されていない読み込み先があります: ${list}${bad.length > 5 ? ` ほか ${bad.length - 5} 件` : ""}。`,
    fix: EXTERNAL_FIX,
    line: lineAt(html, first.offset),
  });
}
