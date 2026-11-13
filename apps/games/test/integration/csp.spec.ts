// R-5.1-2 / R-5.3-1 / R-5.3-2 / R-5.3-4: 配信レスポンスのヘッダ（se#A.2, A.4）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  GAMES_ORIGIN,
  HASH_A,
  type Harness,
  HTML_A,
  POST_A,
  POST_B,
  startWorker,
} from "./helpers.ts";

let w: Harness;
beforeAll(async () => {
  w = await startWorker();
  await w.putGame(HASH_A, HTML_A);
  await w.putServe(POST_A, { hash: HASH_A, status: "ok" });
});
afterAll(() => w.dispose());

const expectedCsp = (postId: string): string =>
  [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${GAMES_ORIGIN}/p/${postId}/ ${GAMES_ORIGIN}/lib/`,
    "style-src 'unsafe-inline'",
    `img-src ${GAMES_ORIGIN}/p/${postId}/assets/ blob:`,
    `media-src ${GAMES_ORIGIN}/p/${postId}/assets/ blob:`,
    `font-src ${GAMES_ORIGIN}/p/${postId}/assets/`,
    `connect-src ${GAMES_ORIGIN}/p/${postId}/assets/ ${GAMES_ORIGIN}/lib/`,
    "worker-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${APP_ORIGIN}`,
  ].join("; ");

function expectCommonHeaders(res: Response): void {
  expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("location")).toBeNull();
}

describe("配信レスポンスのヘッダ（se#A.4）", () => {
  it("R-5.3-1: HTML に投稿ごとの CSP と CORP / nosniff / Referrer-Policy が付く", async () => {
    const res = await w.get(`/p/${POST_A}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(expectedCsp(POST_A));
    expectCommonHeaders(res);
    expect(await res.text()).toBe(HTML_A);
  });

  it("R-5.3-1 / R-5.1-2: アセットのパス・存在しない投稿の 404 にも同じ形のヘッダが付き、Set-Cookie がない", async () => {
    for (const [path, postId] of [
      [`/p/${POST_A}/assets/x.png`, POST_A],
      [`/p/${POST_B}/`, POST_B],
    ] as const) {
      const res = await w.get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-security-policy"), path).toBe(expectedCsp(postId));
      expectCommonHeaders(res);
    }
  });

  it("R-5.3-1: GET / HEAD 以外は 405 で、同じヘッダが付く", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const res = await w.get(`/p/${POST_A}/`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD");
      expect(res.headers.get("content-security-policy"), method).toBe(expectedCsp(POST_A));
      expectCommonHeaders(res);
    }
  });

  it("HEAD は本文なしで GET と同じヘッダ", async () => {
    const res = await w.get(`/p/${POST_A}/`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(expectedCsp(POST_A));
    expect(await res.text()).toBe("");
  });

  it("R-5.3-2: 投稿 A の CSP に投稿 B のパスが含まれない", async () => {
    const res = await w.get(`/p/${POST_A}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`/p/${POST_A}/`);
    expect(csp).not.toContain(POST_B);
    // 配信オリジン全体やワイルドカードを許すソースがない（パスなしのオリジンは全パスに一致する）
    for (const src of csp.split(/[\s;]+/).filter((s) => s.startsWith("https://"))) {
      if (src === APP_ORIGIN) continue;
      expect(
        src.startsWith(`${GAMES_ORIGIN}/p/${POST_A}/`) || src === `${GAMES_ORIGIN}/lib/`,
        src,
      ).toBe(true);
    }
    expect(csp).not.toContain("*");
  });

  it("R-5.3-4: 末尾スラッシュなし・余計なパス・二重スラッシュは 3xx ではなく 404", async () => {
    for (const path of [
      `/p/${POST_A}`,
      `/p/${POST_A}/index.html`,
      `/p/${POST_A}//`,
      `/p//${POST_A}/`,
      "/p/",
      "/",
      "/favicon.ico",
      `/P/${POST_A}/`,
      `/p/${POST_A.toLowerCase()}/`,
    ]) {
      const res = await w.get(path);
      expect(res.status, path).toBe(404);
      expectCommonHeaders(res);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("sandbox");
      expect(csp, path).toContain("default-src 'none'");
    }
  });

  it("投稿 ID を含まないパスの 404 は、何も読めない CSP になる", async () => {
    const res = await w.get("/nope");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  });
});
