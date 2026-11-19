// R-5.2-1 / R-5.2-2: Host が Guest を埋め込む iframe の属性（se#A.3）。試遊ページとラン画面が同じ部品を使う。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GameFrame } from "../src/game-frame.tsx";

const SRC = "https://games.example.workers.dev/p/01M782MV00TMYMTHTGG5C6KS3T/";

/** 描いたマークアップの属性を名前 → 値で読む。HTML の属性名は大文字小文字を区別しないので小文字にそろえる */
function attributes(html: string): Map<string, string> {
  const tag = /^<iframe([^>]*)>/.exec(html)?.[1] ?? "";
  const found = [...tag.matchAll(/\s([a-zA-Z-]+)(?:="([^"]*)")?/g)];
  return new Map(found.map((m) => [(m[1] ?? "").toLowerCase(), m[2] ?? ""]));
}

describe("GameFrame（se#A.3）", () => {
  it("R-5.2-1 sandbox は allow-scripts だけ", () => {
    const attrs = attributes(renderToStaticMarkup(<GameFrame src={SRC} visible />));
    expect(attrs.get("sandbox")).toBe("allow-scripts");
    expect(attrs.get("src")).toBe(SRC);
  });

  it("R-5.2-2 referrerpolicy は no-referrer、credentialless を付け、allow を付けない（#184）", () => {
    const attrs = attributes(renderToStaticMarkup(<GameFrame src={SRC} visible />));
    expect(attrs.get("referrerpolicy")).toBe("no-referrer");
    expect(attrs.has("credentialless")).toBe(true);
    expect(attrs.has("allow")).toBe(false);
    expect(attrs.has("allowfullscreen")).toBe(false);
  });

  it("不可視（先読み。run#A.4）でも属性は同じで、見た目だけが違う", () => {
    const shown = attributes(renderToStaticMarkup(<GameFrame src={SRC} visible />));
    const hidden = attributes(renderToStaticMarkup(<GameFrame src={SRC} visible={false} />));
    expect(hidden.get("style")).toContain("visibility:hidden");
    expect(hidden.get("style")).toContain("pointer-events:none");
    expect(shown.get("style")).not.toContain("visibility");
    for (const name of ["sandbox", "referrerpolicy", "credentialless", "src"]) {
      expect(hidden.get(name), name).toBe(shown.get(name));
    }
  });

  it("iframe を描くのはこの部品だけ（ほかの場所で属性を付け忘れない）", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const users = files.filter((f) => /<iframe\b/.test(readFileSync(join(src, f), "utf8")));
    expect(users).toEqual(["game-frame.tsx"]);
  });
});
