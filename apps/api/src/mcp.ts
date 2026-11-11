/**
 * MCP サーバ（mcp.md）。ツールの入出力の形と説明文だけを持ち、処理は API の関数（publish.ts）を同じプロセスで呼ぶ。
 * 公開するのはツール 3 本とリソース 1 つだけ（mc#A.3、C1）。
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { GUIDE_MARKDOWN } from "./guide.gen.ts";
import { listMyGames, unpublishGame } from "./my-games.ts";
import { type PublishDeps, publishGame, type ToolError, type ToolOutcome } from "./publish.ts";

/** mc#A.2: `version` はデプロイのコミット短縮ハッシュ（Vercel が入れる環境変数。ローカルは dev） */
export const MCP_SERVER_INFO = {
  name: "gamefeed",
  version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
} as const;

/** mc#A.4（暫定）。AI がこれだけを読んで正しく動けるように書く。変えるときは下書き → 試遊 → 公開の流れを変えない */
export const PUBLISH_GAME_DESCRIPTION = [
  "GameFeed にミクロゲームを投稿する。先にリソース `gf://guide` を読み、その規約（1 ファイルの HTML、`gf:*` メタ、`GF` SDK、使えない API）に沿って HTML を書くこと。",
  "初回は下書きになり、`post_id` と試遊 URL が返る。作者に試遊 URL を開いて遊んでもらい、「診断をコピー」で貼られた文に従って直す。直したら同じ `post_id` を渡して再投稿する（内容が置き換わる）。",
  "`rejected` で返ったら `errors[].fix` のとおりに直して再投稿する。`warnings` は通るが、作者に伝える。",
  "作者が公開を望んだときだけ `publish: true` を付ける。公開後は内容を変えられない。直すなら新しい下書きにする。",
  "投稿は GameFeed 上でのリミックス（改変と再投稿、元作者の表示つき）を許諾したものとして扱う。作者に伝えておくこと。",
].join("\n");

export const LIST_MY_GAMES_DESCRIPTION =
  "自分の投稿の一覧。状態（下書き・公開・制限中など）、プレイ数、いいね、校正までの残りを返す。「ランに入りました」は `calibration: calibrated` で分かる。制限中なら理由（通報カテゴリ）が付く。";

export const UNPUBLISH_GAME_DESCRIPTION =
  "公開した投稿を非公開にする。取り消せる（作者がサイトで再公開できる）。削除ではない。";

export const GUIDE_URI = "gf://guide";
export const GUIDE_DESCRIPTION = "GameFeed のミクロゲーム規約。`publish_game` を呼ぶ前に読む。";

export interface McpContext {
  /** アクセストークンの `sub`（= `auth_user.id` = `users.id`）。requireMcpAuth を通っていれば必ずある */
  userId?: string | undefined;
  publish: PublishDeps;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** 成功。`structuredContent` を読まないクライアントのために、同じ JSON を text にも入れる */
const success = (value: object): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

/** mc#A.10: ツールの失敗は `isError: true` と `structuredContent.{code, message, errors?, reason?}` */
const failure = (error: ToolError): ToolResult => ({ ...success(error), isError: true });

/** リクエストごとに新しい McpServer を作る（stateless。mc#B.6）。 */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);

  server.registerTool(
    "publish_game",
    {
      title: "GameFeed に投稿する",
      description: PUBLISH_GAME_DESCRIPTION,
      // 長さの検査は publishGame が行い、`invalid` として返す（mc#A.10）。ここは型だけ
      inputSchema: z.object({
        html: z.string().describe("ゲームの index.html 全文（1 ファイル、128 KB まで）"),
        title: z.string().optional().describe("題。省略時は <title>。1〜40 文字"),
        prompt: z.string().optional().describe("作者が AI に頼んだ文。1000 文字まで"),
        post_id: z
          .string()
          .optional()
          .describe("置き換える下書きの post_id。前回の publish_game が返したもの"),
        publish: z.boolean().optional().describe("true でそのまま公開する。既定は false（下書き）"),
      }),
    },
    async (input) => toResult(await publishGame(ctx.publish, requireUser(ctx), input)),
  );

  server.registerTool(
    "list_my_games",
    { title: "自分の投稿の一覧", description: LIST_MY_GAMES_DESCRIPTION },
    // 出力は一覧だが、structuredContent はオブジェクトでなければならないので `games` に入れる
    async () => toResult(await listMyGames(ctx.publish, requireUser(ctx))),
  );

  server.registerTool(
    "unpublish_game",
    {
      title: "投稿を非公開にする",
      description: UNPUBLISH_GAME_DESCRIPTION,
      inputSchema: z.object({ post_id: z.string().describe("非公開にする投稿の post_id") }),
    },
    async (input) => toResult(await unpublishGame(ctx.publish, requireUser(ctx), input)),
  );

  server.registerResource(
    "guide",
    GUIDE_URI,
    {
      title: "GameFeed ミクロゲーム規約",
      description: GUIDE_DESCRIPTION,
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: GUIDE_URI, mimeType: "text/markdown", text: GUIDE_MARKDOWN }],
    }),
  );

  return server;
}

function toResult(outcome: ToolOutcome<object>): ToolResult {
  if (outcome.ok) return success(outcome.value);
  // banned はツールの結果にしない（mc#A.2: トークンを無効として 401。HTTP 層の検査は moderation の実装で入れる）
  if (outcome.error.code === "banned") throw new Error("unauthorized");
  return failure(outcome.error);
}

function requireUser(ctx: McpContext): string {
  if (!ctx.userId) throw new Error("unauthorized");
  return ctx.userId;
}

/** fetch 互換の MCP ハンドラ。2025 世代（セッション型）と 2026-07-28 の両方を無状態で受ける。 */
export function createMcpFetchHandler(publish: PublishDeps) {
  return createMcpHandler((req) =>
    createMcpServer({ userId: userIdFromAuthInfo(req.authInfo), publish }),
  );
}

/** requireMcpAuth の検証済みクレームから詰めた `extra.userId` を取り出す。 */
export function userIdFromAuthInfo(authInfo?: {
  extra?: Record<string, unknown>;
}): string | undefined {
  const v = authInfo?.extra?.userId;
  return typeof v === "string" ? v : undefined;
}
