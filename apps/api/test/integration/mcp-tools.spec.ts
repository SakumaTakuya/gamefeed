/**
 * MCP のツール層（mcp.md A.3 / A.4 / A.10）。
 *
 * `createMcpServer` に MCP 公式 SDK のクライアントをメモリ内のトランスポートで繋ぎ、
 * ツールの入出力の形（`structuredContent`、`isError`）を確かめる。OAuth を通した経路は mcp-oauth.spec.ts。
 * DB は本物、R2 / KV は fake（mc#A.8）。
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { user as authUser } from "../../src/db/auth-schema.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import { GUIDE_MARKDOWN } from "../../src/guide.gen.ts";
import { createMcpServer } from "../../src/mcp.ts";
import type { PublishDeps } from "../../src/publish.ts";
import { gameHtml } from "../helpers/game-html.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので MCP ツールの integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const APP = "https://app.example.test";
const ME = "U00000000000000000000000ME";
const OTHER = "U0000000000000000000OTHER1";

/** ツール結果の最初の text ブロックを JSON として読む */
function textJson(content: unknown): unknown {
  const first = (content as { type: string; text?: string }[])[0];
  if (first?.type !== "text" || first.text === undefined) throw new Error("text ブロックがない");
  return JSON.parse(first.text);
}

dbSuite("MCP ツール（mc#A.3 / A.10）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let deps: PublishDeps;

  beforeAll(async () => {
    const h = createDb(url as string, { max: 1 });
    db = h.db;
    close = h.close;
    await resetDb(db);
    await migrateDb(db);
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table posts, games, users, auth_user cascade`);
    for (const id of [ME, OTHER]) {
      await db.insert(authUser).values({ id, name: "Taku Sakuma", email: `${id}@example.test` });
    }
    deps = {
      db,
      storage: { put: async () => {} },
      kv: { put: async () => {} },
      appOrigin: APP,
      now: () => new Date("2026-11-11T03:00:00Z"),
    };
  });

  async function connect(userId: string | undefined = ME, d: PublishDeps = deps): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ userId, publish: d });
    await server.connect(serverSide);
    const client = new Client({ name: "gamefeed-test-client", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("mc#A.2 サーバ名は gamefeed。mc#A.4 publish_game の説明文は gf://guide を先に読む指示から始まる", async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe("gamefeed");
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "publish_game");
    expect(tool?.description).toMatch(
      /^GameFeed にミクロゲームを投稿する。先にリソース `gf:\/\/guide` を読み/,
    );
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "html",
      "post_id",
      "prompt",
      "publish",
      "title",
    ]);
    expect(tool?.inputSchema.required).toEqual(["html"]);
    await client.close();
  });

  it("R-mc.A3-1 tools/list は 3 本、resources/list は gf://guide の 1 つだけ（C1）。本文は game-contract.md の A 部", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_my_games",
      "publish_game",
      "unpublish_game",
    ]);
    const descriptions = new Map(tools.map((t) => [t.name, t.description]));
    expect(descriptions.get("list_my_games")).toMatch(/^自分の投稿の一覧。/);
    expect(descriptions.get("unpublish_game")).toMatch(/^公開した投稿を非公開にする。取り消せる/);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["gf://guide"]);
    expect(resources[0]).toMatchObject({
      mimeType: "text/markdown",
      description: "GameFeed のミクロゲーム規約。`publish_game` を呼ぶ前に読む。",
    });
    const read = await client.readResource({ uri: "gf://guide" });
    expect(read.contents).toEqual([
      { uri: "gf://guide", mimeType: "text/markdown", text: GUIDE_MARKDOWN },
    ]);
    expect(GUIDE_MARKDOWN).toContain("## A.13 ");
    await client.close();
  });

  it("R-mc.A3-2 list_my_games は structuredContent.games に一覧を返す。unpublish_game は {post_id, status}", async () => {
    const client = await connect();
    const html = gameHtml();
    const pub = await client.callTool({ name: "publish_game", arguments: { html, publish: true } });
    const id = (pub.structuredContent as { post_id: string }).post_id;

    const listed = await client.callTool({ name: "list_my_games", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toEqual({
      games: [
        {
          post_id: id,
          title: "まるタップ",
          status: "limited",
          url: `${APP}/g/${id}`,
          calibration: "uncalibrated",
          plays: 0,
          likes: 0,
          calibration_remaining: 20,
          published_at: "2026-11-11T03:00:00.000Z",
          updated_at: "2026-11-11T03:00:00.000Z",
        },
      ],
    });
    expect(textJson(listed.content)).toEqual(listed.structuredContent);

    const un = await client.callTool({ name: "unpublish_game", arguments: { post_id: id } });
    expect(un.isError).toBeFalsy();
    expect(un.structuredContent).toEqual({ post_id: id, status: "unpublished" });
    await client.close();
  });

  it("R-mc.A10-1 unpublish_game: 他人の post_id と存在しない post_id は等しい not_found、removed は invalid_state", async () => {
    const other = await connect(OTHER);
    const theirs = await other.callTool({
      name: "publish_game",
      arguments: { html: gameHtml(), publish: true },
    });
    const theirId = (theirs.structuredContent as { post_id: string }).post_id;
    const client = await connect();
    const a = await client.callTool({ name: "unpublish_game", arguments: { post_id: theirId } });
    const b = await client.callTool({
      name: "unpublish_game",
      arguments: { post_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ" },
    });
    expect(a.isError).toBe(true);
    expect((a.structuredContent as { code: string }).code).toBe("not_found");
    expect(a.structuredContent).toEqual(b.structuredContent);

    await db.execute(sql`update posts set base_status = 'removed' where id = ${theirId}`);
    const c = await other.callTool({ name: "unpublish_game", arguments: { post_id: theirId } });
    expect(c.isError).toBe(true);
    expect((c.structuredContent as { code: string }).code).toBe("invalid_state");
    await client.close();
    await other.close();
  });

  it("R-mc.A3-2 publish_game の成功は structuredContent に {post_id, status, url, warnings, reused}。下書き → 公開で url が変わる", async () => {
    const client = await connect();
    const html = gameHtml();
    const draft = await client.callTool({ name: "publish_game", arguments: { html } });
    expect(draft.isError).toBeFalsy();
    const d = draft.structuredContent as Record<string, unknown>;
    expect(d).toEqual({
      post_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      status: "draft",
      url: `${APP}/draft/${d.post_id}`,
      warnings: [],
      reused: false,
    });
    // content のテキストにも同じ JSON が入る（structuredContent を読まないクライアント向け）
    expect(textJson(draft.content)).toEqual(d);

    const pub = await client.callTool({
      name: "publish_game",
      arguments: { html, post_id: d.post_id, publish: true },
    });
    expect(pub.structuredContent).toEqual({
      post_id: d.post_id,
      status: "limited",
      url: `${APP}/g/${d.post_id}`,
      warnings: [],
      reused: false,
    });
    await client.close();
  });

  it("R-mc.A10-1 rejected は isError: true と structuredContent.{code, message, errors[]}（errors に code / message / fix）", async () => {
    const client = await connect();
    const r = await client.callTool({
      name: "publish_game",
      arguments: { html: gameHtml({ duration: "700" }) },
    });
    expect(r.isError).toBe(true);
    const e = r.structuredContent as { code: string; message: string; errors: unknown[] };
    expect(e.code).toBe("rejected");
    expect(e.message).toEqual(expect.any(String));
    expect(e.errors).toEqual([
      expect.objectContaining({ code: "META_DURATION", fix: expect.stringContaining("180〜600") }),
    ]);
    expect(textJson(r.content)).toEqual(e);
    await client.close();
  });

  it("R-mc.A10-1 他人の post_id と存在しない post_id は structuredContent が等しい not_found", async () => {
    const other = await connect(OTHER);
    const theirs = await other.callTool({ name: "publish_game", arguments: { html: gameHtml() } });
    const theirId = (theirs.structuredContent as { post_id: string }).post_id;
    const client = await connect();
    const a = await client.callTool({
      name: "publish_game",
      arguments: { html: gameHtml({ salt: "mine" }), post_id: theirId },
    });
    const b = await client.callTool({
      name: "publish_game",
      arguments: { html: gameHtml({ salt: "mine" }), post_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ" },
    });
    expect(a.isError).toBe(true);
    expect((a.structuredContent as { code: string }).code).toBe("not_found");
    expect(a.structuredContent).toEqual(b.structuredContent);
    await client.close();
    await other.close();
  });

  it("R-mc.A10-1 limit は reason を伴う。invalid_state / invalid / not_configured もそれぞれの code で返る", async () => {
    const client = await connect();
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "publish_game", arguments: args });
      expect(r.isError).toBe(true);
      return r.structuredContent as { code: string; reason?: string };
    };
    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: "publish_game",
        arguments: { html: gameHtml({ salt: `${i}` }) },
      });
    }
    expect(await call({ html: gameHtml({ salt: "6" }) })).toMatchObject({
      code: "limit",
      reason: "rate",
    });

    const pub = await client.callTool({
      name: "publish_game",
      arguments: { html: gameHtml({ salt: "0" }), publish: true },
    });
    // 同一内容の下書きに戻るだけで公開はされない（mc#A.6 の 3）ので、post_id を付けて公開する
    const id = (pub.structuredContent as { post_id: string }).post_id;
    await client.callTool({
      name: "publish_game",
      arguments: { html: gameHtml({ salt: "0" }), post_id: id, publish: true },
    });
    expect((await call({ html: gameHtml({ salt: "x" }), post_id: id })).code).toBe("invalid_state");
    expect((await call({ html: gameHtml(), title: "あ".repeat(41) })).code).toBe("invalid");
    await client.close();

    const { storage: _s, ...noStorage } = deps;
    const bare = await connect(ME, noStorage);
    const r = await bare.callTool({ name: "publish_game", arguments: { html: gameHtml() } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe("not_configured");
    await bare.close();
  });

  it("R-mc.A10-1 storage_failed と post_restricted", async () => {
    const failing = await connect(ME, {
      ...deps,
      storage: {
        put: async () => {
          throw new Error("R2 に届かない");
        },
      },
    });
    const r = await failing.callTool({ name: "publish_game", arguments: { html: gameHtml() } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe("storage_failed");
    await failing.close();

    await db.execute(sql`update users set status = 'post_restricted' where id = ${ME}`);
    const client = await connect();
    const p = await client.callTool({
      name: "publish_game",
      arguments: { html: gameHtml({ salt: "n" }) },
    });
    expect(p.isError).toBe(true);
    expect((p.structuredContent as { code: string }).code).toBe("post_restricted");
    await client.close();
  });
});
