// SDK の注入（gc#A.4: SDK は配信時に <head> へ注入される）。
import { describe, expect, it } from "vitest";
import { injectSdk } from "../src/inject.ts";

const SDK = "window.GF={}";
const TAG = `<script>${SDK}</script>`;

describe("injectSdk", () => {
  it("<head> の開始タグの直後に入れる（ゲームのスクリプトや meta より前）", () => {
    expect(
      injectSdk(
        '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>x</title></head></html>',
        SDK,
      ),
    ).toBe(
      `<!doctype html><html lang="ja"><head>${TAG}<meta charset="utf-8"><title>x</title></head></html>`,
    );
  });

  it("属性つき・大文字の <HEAD> にも入る。<header> は <head> と見なさない", () => {
    expect(injectSdk('<HEAD data-x="1">a</HEAD>', SDK)).toBe(`<HEAD data-x="1">${TAG}a</HEAD>`);
    expect(injectSdk("<html><header>h</header></html>", SDK)).toBe(
      `<html>${TAG}<header>h</header></html>`,
    );
  });

  it("<head> がなければ <html> の直後、それもなければ doctype の直後、何もなければ先頭", () => {
    expect(injectSdk("<!DOCTYPE html><html><body>a</body></html>", SDK)).toBe(
      `<!DOCTYPE html><html>${TAG}<body>a</body></html>`,
    );
    expect(injectSdk("<!doctype html>\n<canvas></canvas>", SDK)).toBe(
      `<!doctype html>${TAG}\n<canvas></canvas>`,
    );
    expect(injectSdk("<canvas></canvas>", SDK)).toBe(`${TAG}<canvas></canvas>`);
    expect(injectSdk("", SDK)).toBe(TAG);
  });

  it("最初の <head> にだけ入れる", () => {
    const out = injectSdk("<head></head><script>'<head>'</script>", SDK);
    expect(out.split(TAG).length).toBe(2);
    expect(out.startsWith(`<head>${TAG}`)).toBe(true);
  });

  it("SDK の中の </script と <!-- は、スクリプトが途中で閉じないように書き換える", () => {
    const out = injectSdk("<head></head>", "a='</script><!--';b='</SCRIPT>'");
    expect(out).toBe("<head><script>a='<\\/script><\\!--';b='<\\/SCRIPT>'</script></head>");
  });

  it("置換パターン（$& など）を含む SDK でも、そのまま入る", () => {
    expect(injectSdk("<head></head>", "a='$&$1$$'")).toBe(
      "<head><script>a='$&$1$$'</script></head>",
    );
  });
});
