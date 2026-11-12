import { describe, expect, it } from "vitest";
import { createServeKv } from "../src/kv.ts";

// se#A.5: API が KV `serve:<post_id>` → {hash, status} を書く。se#A.8: Cloudflare API（CLOUDFLARE_API_TOKEN、KV 限定）
describe("createServeKv（se#A.5、A.8）", () => {
  const cfg = { accountId: "acct123", namespaceId: "ns456", apiToken: "TOKEN" };

  function capture(status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ success: status === 200 }), { status });
    };
    return { calls, fetchImpl };
  }

  it("serve:<post_id> に {hash, status} の JSON を PUT する（キーの : は符号化する）", async () => {
    const { calls, fetchImpl } = capture();
    await createServeKv(cfg, { fetch: fetchImpl }).put("01JABC", { hash: "h1", status: "draft" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/storage/kv/namespaces/ns456/values/serve%3A01JABC",
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ hash: "h1", status: "draft" });
    const h = new Headers(calls[0]?.init.headers);
    expect(h.get("authorization")).toBe("Bearer TOKEN");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("2xx 以外は例外（呼び出し側がリトライする）。メッセージにトークンは入らない", async () => {
    const { fetchImpl } = capture(500);
    const err = await createServeKv(cfg, { fetch: fetchImpl })
      .put("01JABC", { hash: "h1", status: "no" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).not.toContain("TOKEN");
  });
});
