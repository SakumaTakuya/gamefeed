import { describe, expect, it } from "vitest";
import { createR2Storage, sha256Hex, signV4 } from "../src/r2.ts";

// mc#A.8: S3 互換 API に SigV4 で PutObject だけ。AWS SDK は入れない（mc#B.4）
describe("SigV4（mc#A.8）", () => {
  // AWS の公開テストベクタ（S3 API Reference「Signature Calculations … Authorization Header」の PUT Object の例）
  const AWS = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  it("本文のハッシュは AWS の例と一致する", () => {
    expect(sha256Hex("Welcome to Amazon S3.")).toBe(
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    );
  });

  it("PUT Object の例と同じ署名になる（パスの $ は %24 に符号化される）", () => {
    const auth = signV4({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": sha256Hex("Welcome to Amazon S3."),
      },
      region: "us-east-1",
      service: "s3",
      ...AWS,
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class," +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("GET Object の例（Range ヘッダ、空の本文）と同じ署名になる", () => {
    const auth = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        range: "bytes=0-9",
        "x-amz-date": "20130524T000000Z",
        "x-amz-content-sha256": sha256Hex(""),
      },
      region: "us-east-1",
      service: "s3",
      ...AWS,
    });
    expect(auth).toContain(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("createR2Storage（mc#A.8）", () => {
  const cfg = {
    endpoint: "https://acct123.r2.cloudflarestorage.com",
    bucket: "gamefeed-games",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
  };
  const now = () => new Date("2026-11-11T03:04:05Z");

  function capture(status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(status === 200 ? "" : "<Error><Code>AccessDenied</Code></Error>", { status });
    };
    return { calls, fetchImpl };
  }

  it("PUT <endpoint>/<bucket>/<key> に text/html; charset=utf-8 で送る。If-None-Match は付けない", async () => {
    const { calls, fetchImpl } = capture();
    const storage = createR2Storage(cfg, { fetch: fetchImpl, now });
    const html = "<!doctype html><title>あ</title>";
    await storage.put("games/abc123.html", html);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://acct123.r2.cloudflarestorage.com/gamefeed-games/games/abc123.html");
    expect(call?.init.method).toBe("PUT");
    expect(call?.init.body).toBe(html);
    const h = new Headers(call?.init.headers);
    expect(h.get("content-type")).toBe("text/html; charset=utf-8");
    expect(h.get("x-amz-date")).toBe("20261111T030405Z");
    expect(h.get("x-amz-content-sha256")).toBe(sha256Hex(html));
    expect(h.get("if-none-match")).toBeNull();
    // R2 の region は auto。署名するヘッダに content-type を含める
    expect(h.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261111\/auto\/s3\/aws4_request,SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/,
    );
  });

  it("同じ入力なら同じ署名、本文が違えば違う署名", async () => {
    const sig = async (html: string) => {
      const { calls, fetchImpl } = capture();
      await createR2Storage(cfg, { fetch: fetchImpl, now }).put("games/k.html", html);
      return new Headers(calls[0]?.init.headers).get("authorization");
    };
    expect(await sig("a")).toBe(await sig("a"));
    expect(await sig("a")).not.toBe(await sig("b"));
  });

  it("2xx 以外は例外（publish_game が storage_failed にする）。メッセージに状態コードが入り、秘密は入らない", async () => {
    const { fetchImpl } = capture(403);
    const storage = createR2Storage(cfg, { fetch: fetchImpl, now });
    const err = await storage.put("games/k.html", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain("SECRET");
  });

  it("endpoint の末尾スラッシュは無視する", async () => {
    const { calls, fetchImpl } = capture();
    await createR2Storage({ ...cfg, endpoint: `${cfg.endpoint}/` }, { fetch: fetchImpl, now }).put(
      "games/k.html",
      "x",
    );
    expect(calls[0]?.url).toBe("https://acct123.r2.cloudflarestorage.com/gamefeed-games/games/k.html");
  });
});
