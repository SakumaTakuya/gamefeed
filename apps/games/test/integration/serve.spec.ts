// R-se.A5-1 / R-se.A5-2: 配信可否と下書きの試遊トークン（se#A.5）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HASH_A,
  type Harness,
  HTML_A,
  nowSec,
  POST_A,
  POST_B,
  playToken,
  SERVED_A,
  startWorker,
} from "./helpers.ts";

const OK = "01M782MV00TMYMTHTGG5C6KS40";
const NO = "01M782MV00TMYMTHTGG5C6KS41";
const DRAFT = "01M782MV00TMYMTHTGG5C6KS42";
const UNKNOWN = "01M782MV00TMYMTHTGG5C6KS43";
const BROKEN = "01M782MV00TMYMTHTGG5C6KS44";
const MISSING = "01M782MV00TMYMTHTGG5C6KS45";
const ODD = "01M782MV00TMYMTHTGG5C6KS46";

let w: Harness;
let notFoundBody: string;
beforeAll(async () => {
  w = await startWorker();
  await w.putGame(HASH_A, HTML_A);
  await w.putServe(OK, { hash: HASH_A, status: "ok" });
  await w.putServe(NO, { hash: HASH_A, status: "no" });
  await w.putServe(DRAFT, { hash: HASH_A, status: "draft" });
  await w.putServe(BROKEN, "{not json");
  await w.putServe(MISSING, { hash: "b".repeat(64), status: "ok" });
  await w.putServe(ODD, { hash: "../secrets", status: "ok" });
  notFoundBody = await (await w.get(`/p/${UNKNOWN}/`)).text();
});
afterAll(() => w.dispose());

async function expectNotFound(path: string): Promise<void> {
  const res = await w.get(path);
  expect(res.status, path).toBe(404);
  expect(await res.text(), path).toBe(notFoundBody);
  expect(res.headers.get("cache-control"), path).toBe("no-store");
  expect(res.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
}

describe("配信可否（se#A.5）", () => {
  it("R-se.A5-1: ok は配信し、Cache-Control は public, max-age=60", async () => {
    const res = await w.get(`/p/${OK}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SERVED_A);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("R-se.A5-1: no / 未知 / トークンなしの draft は同じ文言の 404", async () => {
    for (const id of [NO, UNKNOWN, DRAFT]) await expectNotFound(`/p/${id}/`);
  });

  it("KV の値が壊れている・hash が形式外・R2 に本体がない場合も同じ 404", async () => {
    for (const id of [BROKEN, ODD, MISSING]) await expectNotFound(`/p/${id}/`);
  });
});

describe("下書きの試遊トークン（se#A.5）", () => {
  it("R-se.A5-2: 正しいトークンなら draft を配信し、Cache-Control は no-store", async () => {
    const res = await w.get(`/p/${DRAFT}/?t=${playToken(DRAFT, nowSec() + 600)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SERVED_A);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("R-se.A5-2: 期限内なら同じトークンを何度でも使える", async () => {
    const t = playToken(DRAFT, nowSec() + 600);
    for (let i = 0; i < 3; i++) expect((await w.get(`/p/${DRAFT}/?t=${t}`)).status).toBe(200);
  });

  it("R-se.A5-2: 期限切れは 404", async () => {
    await expectNotFound(`/p/${DRAFT}/?t=${playToken(DRAFT, nowSec() - 1)}`);
  });

  it("R-se.A5-2: 別の post_id 向けのトークンは 404", async () => {
    await expectNotFound(`/p/${DRAFT}/?t=${playToken(POST_B, nowSec() + 600)}`);
  });

  it("R-se.A5-2: 署名を 1 バイト変える・別の秘密で署名する・形が違うトークンは 404", async () => {
    const good = playToken(DRAFT, nowSec() + 600);
    const [payload = "", sig = ""] = good.split(".");
    const flipped = `${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    const bad = [
      flipped,
      playToken(DRAFT, nowSec() + 600, "other-secret"),
      payload,
      `${payload}.`,
      `.${sig}`,
      `${good}.x`,
      "",
      "%%%",
      // exp を伸ばして元の署名を付ける（ペイロードの改ざん）
      `${Buffer.from(`${DRAFT}.${nowSec() + 99999}`).toString("base64url")}.${sig}`,
      // exp が数字でない
      playToken(DRAFT, Number.NaN),
    ];
    for (const t of bad) await expectNotFound(`/p/${DRAFT}/?t=${encodeURIComponent(t)}`);
  });

  it("R-se.A5-2: 公開後の投稿は ?t= を無視して配信する（壊れたトークンでも）", async () => {
    for (const t of ["garbage", playToken(POST_A, nowSec() - 1)]) {
      const res = await w.get(`/p/${OK}/?t=${t}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    }
  });

  it("no の投稿は有効な形のトークンがあっても 404", async () => {
    await expectNotFound(`/p/${NO}/?t=${playToken(NO, nowSec() + 600)}`);
  });
});
