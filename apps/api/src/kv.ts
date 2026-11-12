/**
 * KV `serve:<post_id>` の書き込み（security.md A.5）。
 * 配信 Worker は KV を読んで配信可否を決める。API からは Cloudflare API で書く（se#A.8: `CLOUDFLARE_API_TOKEN`、KV 限定）。
 */

import type { ServeKv, ServeValue } from "./publish.ts";

export interface KvConfig {
  apiToken: string;
  accountId: string;
  namespaceId: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createServeKv(cfg: KvConfig, opts: { fetch?: FetchLike } = {}): ServeKv {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.namespaceId}/values`;
  return {
    async put(postId: string, value: ServeValue): Promise<void> {
      const res = await doFetch(`${base}/${encodeURIComponent(`serve:${postId}`)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${cfg.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`KV serve:${postId} の書き込みが ${res.status} を返した: ${detail}`);
      }
    },
  };
}
