/**
 * MCP サーバ（spec#9）。#5 の PoC では `publish_game` のダミーだけを公開し、
 * 「OAuth 2.1 で接続したクライアントがツールを呼べる」ことを確かめる。
 * 本実装（静的解析・DB 書き込み・レート制限・list_my_games・unpublish_game・gf://guide）は plan#9（W5）。
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

export const MCP_SERVER_INFO = { name: "gamefeed", version: "0.0.0-poc" } as const;

/** リクエストごとに新しい McpServer を作る（Vercel の無状態関数に合わせる）。 */
export function createMcpServer(ctx: { userId?: string | undefined; baseURL: string }): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);

  server.registerTool(
    "publish_game",
    {
      title: "Publish a game to GameFeed (PoC)",
      description:
        "【PoC・ダミー】GameFeed にミクロゲームを投稿する。この版は何も保存せず、受け取った title と" +
        " HTML のサイズをそのまま返す。接続確認（#5）用。",
      inputSchema: z.object({
        html: z.string().describe("ゲームの index.html 全文（単一ファイル）"),
        title: z.string().min(1).describe("ゲームのタイトル"),
        prompt: z.string().describe("このゲームを作ったときのプロンプト"),
      }),
    },
    async ({ html, title, prompt }) => {
      const postId = `gf:poc-${Date.now().toString(36)}`;
      const result = {
        post_id: postId,
        url: `${ctx.baseURL}/p/${encodeURIComponent(postId)}`,
        warnings: ["この投稿はダミーです（#5 PoC）。保存されていません。"],
        missing_assets: [],
        echo: {
          title,
          html_bytes: new TextEncoder().encode(html).byteLength,
          prompt_chars: prompt.length,
        },
        user_id: ctx.userId ?? null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

/** fetch 互換の MCP ハンドラ。2025 世代（セッション型）と 2026-07-28 の両方を無状態で受ける。 */
export function createMcpFetchHandler(baseURL: string) {
  return createMcpHandler((req) =>
    createMcpServer({ userId: userIdFromAuthInfo(req.authInfo), baseURL }),
  );
}

/** requireMcpAuth の検証済みクレームから詰めた `extra.userId` を取り出す。 */
export function userIdFromAuthInfo(authInfo?: {
  extra?: Record<string, unknown>;
}): string | undefined {
  const v = authInfo?.extra?.userId;
  return typeof v === "string" ? v : undefined;
}
