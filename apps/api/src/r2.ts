/**
 * R2 への書き込み（mcp.md A.8）。S3 互換 API に SigV4 で `PutObject` だけ。
 * AWS SDK は入れない（mc#B.4: 必要なのは 1 操作で、SDK は関数サイズとコールドスタートを増やす）。
 * 読む側は配信 Worker の R2 バインディングで、API は読まない。
 */

import { createHash, createHmac } from "node:crypto";
import type { GameStorage } from "./publish.ts";

export interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  /** `https://<account_id>.r2.cloudflarestorage.com` */
  endpoint: string;
  bucket: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 の非予約文字以外を符号化する（SigV4 の URI 符号化。encodeURIComponent は !'()* を残す） */
const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface SignV4Input {
  method: string;
  url: URL;
  /** 署名に含めるヘッダ（host は url から足す）。`x-amz-date` と `x-amz-content-sha256` が要る */
  headers: Record<string, string>;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** AWS Signature Version 4 の `Authorization` ヘッダの値を作る。クエリ文字列は扱わない（PutObject に要らない） */
export function signV4(input: SignV4Input): string {
  const headers = new Map<string, string>([["host", input.url.host]]);
  for (const [k, v] of Object.entries(input.headers)) {
    headers.set(k.toLowerCase(), v.trim().replace(/\s+/g, " "));
  }
  const amzDate = headers.get("x-amz-date");
  const payloadHash = headers.get("x-amz-content-sha256");
  if (!amzDate || !payloadHash) {
    throw new Error("signV4: x-amz-date と x-amz-content-sha256 が要る");
  }
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalUri = input.url.pathname
    .split("/")
    .map((seg) => uriEncode(decodeURIComponent(seg)))
    .join("/");
  const canonicalRequest = [
    input.method,
    canonicalUri,
    "",
    ...names.map((n) => `${n}:${headers.get(n)}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

/** `20261111T030405Z` の形 */
const amzDateOf = (d: Date): string => d.toISOString().replace(/[-:]|\.\d{3}/g, "");

export function createR2Storage(
  cfg: R2Config,
  opts: { fetch?: FetchLike; now?: () => Date } = {},
): GameStorage {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => new Date());
  const base = cfg.endpoint.replace(/\/+$/, "");
  return {
    async put(key: string, html: string): Promise<void> {
      const url = new URL(`${base}/${cfg.bucket}/${key}`);
      // `If-None-Match: *` は付けない（同じ内容の上書きは無害。mc#A.8）
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "x-amz-date": amzDateOf(now()),
        "x-amz-content-sha256": sha256Hex(html),
      };
      const authorization = signV4({
        method: "PUT",
        url,
        headers,
        region: "auto",
        service: "s3",
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      });
      const res = await doFetch(url.toString(), {
        method: "PUT",
        headers: { ...headers, authorization },
        body: html,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`R2 PutObject ${key} が ${res.status} を返した: ${detail}`);
      }
    },
  };
}
