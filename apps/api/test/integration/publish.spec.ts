/**
 * `publishGame`（mcp.md A.6 / A.7 / A.10）の integration テスト。
 *
 * 本物を使う範囲（docs/testing.md）: Postgres とマイグレーション、静的検査。
 * 差し替えるのは境界の外側だけ: R2（メモリの fake。mc#A.8）、KV（メモリの fake）、時計（手動）。
 * `publishGame` は自分でトランザクションを確定するので、テストごとに表を空にする。
 */

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user as authUser } from "../../src/db/auth-schema.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";
import {
  type GameStorage,
  type PublishDeps,
  type PublishInput,
  publishGame,
  type ServeKv,
  type ServeValue,
  syncServe,
} from "../../src/publish.ts";
import { gameHtml } from "../helpers/game-html.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので publish の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const APP = "https://app.example.test";
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

class FakeStorage implements GameStorage {
  objects = new Map<string, string>();
  failures = 0;
  puts = 0;
  async put(key: string, html: string): Promise<void> {
    this.puts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("R2 に届かない（fake）");
    }
    this.objects.set(key, html);
  }
}

class FakeKv implements ServeKv {
  values = new Map<string, ServeValue>();
  failures = 0;
  puts = 0;
  async put(postId: string, value: ServeValue): Promise<void> {
    this.puts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("KV に届かない（fake）");
    }
    this.values.set(postId, value);
  }
}

dbSuite("publish_game（mc#A.6 / A.7 / A.10）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let storage: FakeStorage;
  let kv: FakeKv;
  /** 手動時計。2026-11-11 12:00 JST から始める */
  let now: Date;
  let deps: PublishDeps;

  const ME = "U00000000000000000000000ME";
  const OTHER = "U0000000000000000000OTHER1";

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
    storage = new FakeStorage();
    kv = new FakeKv();
    now = new Date("2026-11-11T03:00:00Z");
    deps = { db, storage, kv, appOrigin: APP, now: () => now };
    await addUser(ME, "Taku Sakuma");
  });

  async function addUser(id: string, name: string, trustScore?: number): Promise<void> {
    await db.insert(authUser).values({ id, name, email: `${id}@example.test` });
    if (trustScore !== undefined) {
      await db
        .insert(s.users)
        .values({ id, handle: `h-${id.slice(-6).toLowerCase()}`, trustScore });
    }
  }
  const publish = (input: PublishInput, userId = ME) => publishGame(deps, userId, input);
  async function ok(input: PublishInput, userId = ME) {
    const r = await publish(input, userId);
    if (!r.ok) throw new Error(`publish が失敗した: ${JSON.stringify(r.error)}`);
    return r.value;
  }
  async function err(input: PublishInput, userId = ME) {
    const r = await publish(input, userId);
    if (r.ok) throw new Error(`publish が通ってしまった: ${JSON.stringify(r.value)}`);
    return r.error;
  }
  const post = async (id: string) => {
    const [row] = await db.select().from(s.posts).where(eq(s.posts.id, id));
    if (!row) throw new Error(`posts に ${id} がない`);
    return row;
  };
  const game = async (hash: string) => {
    const [row] = await db.select().from(s.games).where(eq(s.games.hash, hash));
    if (!row) throw new Error(`games に ${hash} がない`);
    return row;
  };
  const count = async (table: "posts" | "games" | "users") => {
    const [r] = (await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)}`,
    )) as unknown as [{ n: number }];
    return r.n;
  };
  /** 下書きを直接入れる（上限のテスト用。publishGame を通さない） */
  async function seedDrafts(n: number, userId = ME, createdAt = new Date("2026-11-01T00:00:00Z")) {
    await db
      .insert(s.users)
      .values({ id: userId, handle: `seed-${userId.slice(-6).toLowerCase()}` })
      .onConflictDoNothing();
    for (let i = 0; i < n; i++) {
      const hash = sha256(`seed-${userId}-${i}`);
      await db.insert(s.games).values({ hash, size: 10, r2Key: `games/${hash}.html`, meta: {} });
      await db.insert(s.posts).values({
        id: `SEED${userId.slice(-4)}${String(i).padStart(4, "0")}`,
        userId,
        gameHash: hash,
        title: `seed ${i}`,
        prompt: "",
        treeId: `SEED${userId.slice(-4)}${String(i).padStart(4, "0")}`,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  // ---- 典型 ------------------------------------------------------------------------

  it("R-mc.A3-2 新規は下書きになり、{post_id, status, url, warnings, reused} を返す。posts / games / R2 / KV に書く（mc#A.6）", async () => {
    const html = gameHtml();
    const v = await ok({ html });
    expect(v).toEqual({
      post_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      status: "draft",
      url: `${APP}/draft/${v.post_id}`,
      warnings: [],
      reused: false,
    });

    const hash = sha256(html);
    const p = await post(v.post_id);
    expect(p).toMatchObject({
      userId: ME,
      gameHash: hash,
      title: "まるタップ",
      prompt: "",
      parentId: null,
      treeId: v.post_id,
      depth: 0,
      baseStatus: "draft",
      publishedAt: null,
    });
    expect(p.createdAt).toEqual(now);
    expect(p.updatedAt).toEqual(now);

    const g = await game(hash);
    expect(g.size).toBe(Buffer.byteLength(html, "utf8"));
    expect(g.r2Key).toBe(`games/${hash}.html`);
    expect(g.meta).toEqual({
      title: "まるタップ",
      verb: "タップ！",
      input: "tap",
      duration_frames: 300,
      target: 12,
      deterministic: true,
      warnings: [],
    });
    expect(g.storedAt).toEqual(now);
    expect(storage.objects.get(`games/${hash}.html`)).toBe(html);
    expect(kv.values.get(v.post_id)).toEqual({ hash, status: "draft" });
  });

  it("R-mc.A5-1 最初の呼び出しで users 行ができる（trust_score 10、active、handle は slug）", async () => {
    expect(await count("users")).toBe(0);
    await ok({ html: gameHtml() });
    const rows = await db.select().from(s.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ME,
      handle: "taku-sakuma",
      trustScore: 10,
      status: "active",
    });
  });

  it("R-mc.A3-2 title / prompt を渡せばそれが入る", async () => {
    const v = await ok({
      html: gameHtml(),
      title: "  ぼくのゲーム ",
      prompt: "丸をタップするゲームを作って",
    });
    expect(await post(v.post_id)).toMatchObject({
      title: "ぼくのゲーム",
      prompt: "丸をタップするゲームを作って",
    });
  });

  it("R-mc.A3-2 静的検査の警告は warnings に {code, message} で返り、games.meta.warnings にも残る（mc#A.6 の 9）", async () => {
    const html = gameHtml({ head: '<meta name="viewport" content="width=320">' });
    const v = await ok({ html });
    expect(v.warnings).toEqual([{ code: "VIEWPORT", message: expect.any(String) }]);
    expect(((await game(sha256(html))).meta as { warnings: unknown }).warnings).toEqual(v.warnings);
  });

  it("gc#A.3 gf:deterministic が false なら games.meta.deterministic は false", async () => {
    const html = gameHtml({ head: '<meta name="gf:deterministic" content="false">' });
    await ok({ html });
    expect((await game(sha256(html))).meta).toMatchObject({ deterministic: false });
  });

  // ---- 拒否（C2） ------------------------------------------------------------------

  it("R-9-3 契約に合わない HTML は rejected。errors[].fix に直し方が入り、games / posts / R2 / KV に何も書かない", async () => {
    const e = await err({ html: gameHtml({ duration: "700" }) });
    expect(e.code).toBe("rejected");
    expect(e.message).toEqual(expect.any(String));
    expect(e.errors).toEqual([
      expect.objectContaining({
        code: "META_DURATION",
        message: expect.any(String),
        fix: expect.stringContaining("180〜600"),
      }),
    ]);
    expect(await count("posts")).toBe(0);
    expect(await count("games")).toBe(0);
    expect(storage.puts).toBe(0);
    expect(kv.puts).toBe(0);
  });

  it("R-9-3 置き換えが rejected なら下書きは元のまま", async () => {
    const html = gameHtml();
    const v = await ok({ html });
    const e = await err({ html: gameHtml({ duration: "10" }), post_id: v.post_id });
    expect(e.code).toBe("rejected");
    expect((await post(v.post_id)).gameHash).toBe(sha256(html));
    expect(await count("games")).toBe(1);
    expect(kv.values.get(v.post_id)).toEqual({ hash: sha256(html), status: "draft" });
  });

  // ---- 置き換え（mc#A.6 の 2, 7） ------------------------------------------------------

  it("R-mc.A6-1 post_id を渡すと下書きの内容が置き換わる（同じ post_id、updated_at が進み、KV は新しい hash）", async () => {
    const v1 = await ok({ html: gameHtml({ salt: "1" }), title: "一" });
    now = new Date(now.getTime() + 60_000);
    const html2 = gameHtml({ salt: "2", title: "二つ目" });
    const v2 = await ok({ html: html2, post_id: v1.post_id });
    expect(v2).toEqual({ ...v1, reused: false });
    const p = await post(v1.post_id);
    expect(p).toMatchObject({ gameHash: sha256(html2), title: "二つ目", baseStatus: "draft" });
    expect(p.updatedAt).toEqual(now);
    expect(p.createdAt).not.toEqual(now);
    expect(await count("posts")).toBe(1);
    expect(kv.values.get(v1.post_id)).toEqual({ hash: sha256(html2), status: "draft" });
    expect(storage.objects.has(`games/${sha256(html2)}.html`)).toBe(true);
  });

  it("R-mc.A10-1 他人の post_id と存在しない post_id は同じ not_found（C6）", async () => {
    await addUser(OTHER, "Other");
    const theirs = await ok({ html: gameHtml({ salt: "theirs" }) }, OTHER);
    const a = await err({ html: gameHtml(), post_id: theirs.post_id });
    const b = await err({ html: gameHtml(), post_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ" });
    expect(a.code).toBe("not_found");
    expect(a).toEqual(b);
    expect((await post(theirs.post_id)).gameHash).toBe(sha256(gameHtml({ salt: "theirs" })));
  });

  it("R-mc.A10-1 公開済みの post_id への置き換えは invalid_state（内容は変わらない）", async () => {
    const html = gameHtml();
    const v = await ok({ html, publish: true });
    const e = await err({ html: gameHtml({ salt: "x" }), post_id: v.post_id });
    expect(e.code).toBe("invalid_state");
    expect((await post(v.post_id)).gameHash).toBe(sha256(html));
  });

  // ---- 公開（mc#A.6 の 8、mo#A.2、C4） ---------------------------------------------------

  it("R-mo.A2-1 publish: true は trust_score 30 未満なら limited。published_at が入り、url はゲームページ、KV は ok", async () => {
    const v = await ok({ html: gameHtml(), publish: true });
    expect(v).toMatchObject({ status: "limited", url: `${APP}/g/${v.post_id}`, reused: false });
    const p = await post(v.post_id);
    expect(p.baseStatus).toBe("limited");
    expect(p.publishedAt).toEqual(now);
    expect(kv.values.get(v.post_id)).toEqual({ hash: p.gameHash, status: "ok" });
  });

  it("R-mo.A2-1 trust_score 30 以上なら public。29 は limited", async () => {
    await addUser(OTHER, "Other", 30);
    expect((await ok({ html: gameHtml(), publish: true }, OTHER)).status).toBe("public");
    await db.update(s.users).set({ trustScore: 29 }).where(eq(s.users.id, OTHER));
    expect((await ok({ html: gameHtml({ salt: "2" }), publish: true }, OTHER)).status).toBe(
      "limited",
    );
  });

  it("R-mo.A2-1 下書きを post_id + publish: true で公開できる。公開後に trust_score が上がっても limited のまま", async () => {
    const html = gameHtml();
    const d = await ok({ html });
    const v = await ok({ html, post_id: d.post_id, publish: true });
    expect(v).toMatchObject({ post_id: d.post_id, status: "limited", reused: false });
    await db.update(s.users).set({ trustScore: 30 }).where(eq(s.users.id, ME));
    await ok({ html: gameHtml({ salt: "next" }), publish: true });
    expect((await post(d.post_id)).baseStatus).toBe("limited");
    expect(await count("posts")).toBe(2);
  });

  // ---- 同一内容（mc#A.7、C3） ----------------------------------------------------------

  it("R-mc.A7-1 同じ HTML を post_id なしで 2 回・3 回送っても下書きは 1 つ（reused: true）。title / prompt は更新される", async () => {
    const html = gameHtml();
    const v1 = await ok({ html, title: "一", prompt: "p1" });
    now = new Date(now.getTime() + 1000);
    const v2 = await ok({ html, title: "二", prompt: "p2" });
    const v3 = await ok({ html });
    expect(v2).toEqual({ ...v1, reused: true });
    expect(v3).toEqual({ ...v1, reused: true });
    expect(await count("posts")).toBe(1);
    expect(await count("games")).toBe(1);
    // 3 回目は title / prompt を省略したので既定値（<title> と空）
    expect(await post(v1.post_id)).toMatchObject({
      title: "まるタップ",
      prompt: "",
      updatedAt: now,
    });
    // R2 には 1 回しか書かない（stored_at が入っている）
    expect(storage.puts).toBe(1);
  });

  it("R-mc.A7-1 下書きが 10 件あっても、当日の上限に達していても、同じ HTML は reused で通る", async () => {
    const html = gameHtml();
    const v = await ok({ html });
    for (let i = 0; i < 4; i++) await ok({ html: gameHtml({ salt: `r${i}` }) });
    await seedDrafts(5);
    expect((await err({ html: gameHtml({ salt: "new" }) })).code).toBe("limit");
    expect(await ok({ html })).toEqual({ ...v, reused: true });
    // 拒否される内容でも、同一内容の確認が先（mc#A.6 の 3）なので静的検査を通さない
    expect(await count("posts")).toBe(10);
  });

  it("R-mc.A7-1 公開済みと同じ HTML は、その投稿を status そのままで返す。title / prompt は変えず、publish: true でも何もしない", async () => {
    const html = gameHtml();
    const v = await ok({ html, title: "元", prompt: "元の文", publish: true });
    now = new Date(now.getTime() + 1000);
    const again = await ok({ html, title: "別", prompt: "別の文", publish: true });
    expect(again).toEqual({ ...v, reused: true });
    const p = await post(v.post_id);
    expect(p).toMatchObject({ title: "元", prompt: "元の文", baseStatus: "limited" });
    expect(p.updatedAt).not.toEqual(now);
    expect(await count("posts")).toBe(1);
  });

  it("R-mc.A7-1 unpublished / restricted の内容を送ると、その status で返る（KV は no）", async () => {
    const h1 = gameHtml({ salt: "u" });
    const h2 = gameHtml({ salt: "r" });
    const u = await ok({ html: h1, publish: true });
    const r = await ok({ html: h2, publish: true });
    await db.update(s.posts).set({ baseStatus: "unpublished" }).where(eq(s.posts.id, u.post_id));
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, r.post_id));
    expect(await ok({ html: h1 })).toEqual({ ...u, status: "unpublished", reused: true });
    expect(await ok({ html: h2 })).toEqual({ ...r, status: "restricted", reused: true });
    expect(kv.values.get(u.post_id)).toEqual({ hash: sha256(h1), status: "no" });
    expect(kv.values.get(r.post_id)).toEqual({ hash: sha256(h2), status: "no" });
  });

  it("R-mc.A7-1 post_id なしで同じ HTML の下書きに publish: true を付けても公開しない（status: draft、reused: true。mc#A.6 の 3）", async () => {
    const html = gameHtml();
    const d = await ok({ html });
    const again = await ok({ html, publish: true });
    expect(again).toEqual({ ...d, reused: true });
    const p = await post(d.post_id);
    expect(p).toMatchObject({ baseStatus: "draft", publishedAt: null });
    expect(kv.values.get(d.post_id)?.status).toBe("draft");
  });

  it("R-mc.A7-1 同じ内容の自分の投稿が複数あるときは updated_at が最も新しい投稿を返す。removed が 1 つでもあれば invalid_state", async () => {
    const html = gameHtml();
    const live = await ok({ html, publish: true });
    now = new Date(now.getTime() + 1000);
    // 別の下書きを、公開済みと同じ内容で置き換える（置き換えは同一内容を確認しない）
    const draft = await ok({ html: gameHtml({ salt: "other" }) });
    now = new Date(now.getTime() + 1000);
    await ok({ html, post_id: draft.post_id });
    expect(await ok({ html })).toMatchObject({
      post_id: draft.post_id,
      status: "draft",
      reused: true,
    });

    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, live.post_id));
    expect((await err({ html })).code).toBe("invalid_state");
  });

  it("R-mc.A7-1 removed の内容の再投稿は invalid_state（新しい行を作らない）", async () => {
    const html = gameHtml();
    const v = await ok({ html, publish: true });
    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, v.post_id));
    const e = await err({ html });
    expect(e.code).toBe("invalid_state");
    expect(await count("posts")).toBe(1);
  });

  it("R-mc.A7-1 他人の投稿と同じ HTML は気にしない（games の行を共有し、自分の投稿ができる）", async () => {
    await addUser(OTHER, "Other");
    const html = gameHtml();
    const theirs = await ok({ html }, OTHER);
    const mine = await ok({ html });
    expect(mine.reused).toBe(false);
    expect(mine.post_id).not.toBe(theirs.post_id);
    expect(await count("games")).toBe(1);
    expect(await count("posts")).toBe(2);
  });

  // ---- 上限（mc#A.6 の 4、mo#A.5） -----------------------------------------------------

  it("R-9-4 trust_score 30 未満は新規 5 件/日。6 件目は limit（reason: rate）で何も書かない。日付が変わると通る", async () => {
    for (let i = 0; i < 5; i++) await ok({ html: gameHtml({ salt: `n${i}` }) });
    const e = await err({ html: gameHtml({ salt: "n5" }) });
    expect(e).toMatchObject({ code: "limit", reason: "rate" });
    expect(await count("posts")).toBe(5);
    expect(await count("games")).toBe(5);
    // 日付の境界は JST の 0 時（暫定）。23:59:59 JST はまだ当日
    now = new Date("2026-11-11T14:59:59Z");
    expect((await err({ html: gameHtml({ salt: "n5" }) })).reason).toBe("rate");
    now = new Date("2026-11-11T15:00:00Z");
    expect((await ok({ html: gameHtml({ salt: "n5" }) })).reused).toBe(false);
  });

  it("R-9-4 置き換え（post_id 指定）は数えない。6 回置き換えても通り、その後も新規を 4 件出せる", async () => {
    const v = await ok({ html: gameHtml({ salt: "base" }) });
    for (let i = 0; i < 6; i++)
      await ok({ html: gameHtml({ salt: `rep${i}` }), post_id: v.post_id });
    for (let i = 0; i < 4; i++) await ok({ html: gameHtml({ salt: `more${i}` }) });
    expect((await err({ html: gameHtml({ salt: "over" }) })).reason).toBe("rate");
  });

  it("R-9-4 trust_score 30 以上は新規 30 件/日", async () => {
    await addUser(OTHER, "Other", 30);
    for (let i = 0; i < 30; i++)
      await ok({ html: gameHtml({ salt: `p${i}` }), publish: true }, OTHER);
    expect(await err({ html: gameHtml({ salt: "p30" }) }, OTHER)).toMatchObject({
      code: "limit",
      reason: "rate",
    });
  });

  it("R-9-4 自分の下書きが 10 件あると新規は limit（reason: drafts）。置き換えと公開済みは数えない（I11）", async () => {
    await seedDrafts(10);
    const e = await err({ html: gameHtml() });
    expect(e).toMatchObject({ code: "limit", reason: "drafts" });
    expect(await count("posts")).toBe(10);
    // 置き換えは通る
    await ok({ html: gameHtml(), post_id: "SEED00ME0000" });
    // 1 件を公開すれば空く
    await ok({ html: gameHtml(), post_id: "SEED00ME0000", publish: true });
    expect((await ok({ html: gameHtml({ salt: "new" }) })).status).toBe("draft");
  });

  // ---- users.status（mc#A.6 の 1） ----------------------------------------------------

  it("R-mo.A5-2 post_restricted のユーザーは post_restricted で拒否され、何も書かない（置き換え・公開も）", async () => {
    const d = await ok({ html: gameHtml() });
    await db.update(s.users).set({ status: "post_restricted" }).where(eq(s.users.id, ME));
    const before = storage.puts + kv.puts;
    expect((await err({ html: gameHtml({ salt: "x" }) })).code).toBe("post_restricted");
    expect((await err({ html: gameHtml(), post_id: d.post_id, publish: true })).code).toBe(
      "post_restricted",
    );
    expect(await count("posts")).toBe(1);
    expect((await post(d.post_id)).baseStatus).toBe("draft");
    expect(storage.puts + kv.puts).toBe(before);
  });

  it("mc#A.6 の 1: banned のユーザーは banned で拒否され、何も書かない", async () => {
    await addUser(OTHER, "Other", 10);
    await db.update(s.users).set({ status: "banned" }).where(eq(s.users.id, OTHER));
    expect((await err({ html: gameHtml() }, OTHER)).code).toBe("banned");
    expect(await count("posts")).toBe(0);
  });

  // ---- R2 と KV の順（mc#A.6 の 11〜12、C7） ---------------------------------------------

  it("R-mc.A6-1 R2 が失敗すると storage_failed。games / posts は残り stored_at は NULL、KV は書かれない。同じ入力の 2 回目で R2 だけやり直す", async () => {
    const html = gameHtml();
    const hash = sha256(html);
    storage.failures = 1;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = await err({ html, title: "題" });
    expect(e.code).toBe("storage_failed");
    // 原因（R2 の応答）は運営がログで追えるように残す。作者に返す文には入れない
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[1])).toContain("R2 に届かない");
    expect(e.message).not.toContain("R2 に届かない");
    logged.mockRestore();
    expect(await count("posts")).toBe(1);
    expect((await game(hash)).storedAt).toBeNull();
    expect(kv.puts).toBe(0);

    now = new Date(now.getTime() + 5000);
    const v = await ok({ html, title: "題" });
    expect(v).toMatchObject({ status: "draft", reused: true });
    expect(await count("posts")).toBe(1);
    expect((await game(hash)).storedAt).toEqual(now);
    expect(storage.objects.get(`games/${hash}.html`)).toBe(html);
    expect(kv.values.get(v.post_id)).toEqual({ hash, status: "draft" });
  });

  it("R-mc.A6-1 公開の呼び出しで R2 が失敗しても、同じ入力の 2 回目で公開済みの投稿に戻り R2 と KV が書かれる", async () => {
    const html = gameHtml();
    storage.failures = 1;
    expect((await err({ html, publish: true })).code).toBe("storage_failed");
    expect(kv.puts).toBe(0);
    const v = await ok({ html, publish: true });
    expect(v).toMatchObject({ status: "limited", reused: true });
    expect(kv.values.get(v.post_id)).toEqual({ hash: sha256(html), status: "ok" });
  });

  it("mc#A.6 の 12: KV の書き込みは失敗したらリトライする。3 回とも失敗したら storage_failed で、同じ入力の呼び直しで KV だけ書き直す", async () => {
    kv.failures = 2;
    const v = await ok({ html: gameHtml() });
    expect(kv.puts).toBe(3);
    expect(kv.values.get(v.post_id)?.status).toBe("draft");

    kv.failures = 3;
    const html = gameHtml({ salt: "2" });
    const e = await err({ html, publish: true });
    expect(e.code).toBe("storage_failed");
    expect(await count("posts")).toBe(2);
    expect((await game(sha256(html))).storedAt).not.toBeNull();

    const puts = storage.puts;
    const w = await ok({ html, publish: true });
    expect(w).toMatchObject({ status: "limited", reused: true });
    expect(kv.values.get(w.post_id)).toEqual({ hash: sha256(html), status: "ok" });
    // R2 は書き直さない（stored_at が入っている）
    expect(storage.puts).toBe(puts);
    expect(await count("posts")).toBe(2);
  });

  it("se#A.5 KV に書くのは書く時点で DB に確定している状態（並行する非公開の no を、古い ok で上書きしない）", async () => {
    const html = gameHtml();
    const v = await ok({ html, publish: true });
    expect(kv.values.get(v.post_id)?.status).toBe("ok");
    // publish_game が「公開済み」と見た後、KV に書く前に unpublish が確定した状況を作る:
    // DB だけ unpublished にしてから syncServe を呼ぶ
    await db.update(s.posts).set({ baseStatus: "unpublished" }).where(eq(s.posts.id, v.post_id));
    expect(await syncServe(db, kv, v.post_id)).toBe(true);
    expect(kv.values.get(v.post_id)).toEqual({ hash: sha256(html), status: "no" });

    // 行が無い post_id は何も書かない
    const puts = kv.puts;
    expect(await syncServe(db, kv, "01JZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(true);
    expect(kv.puts).toBe(puts);

    // 書けなければ false
    kv.failures = 99;
    expect(await syncServe(db, kv, v.post_id)).toBe(false);
  });

  it("mc#A.12 C7 いまの内容が R2 に無い（stored_at NULL）間は KV を書かず false（並行する置き換えの R2 が失敗した状況）", async () => {
    const a = gameHtml();
    const b = gameHtml({ title: "置き換え後" });
    const v = await ok({ html: a });
    expect(kv.values.get(v.post_id)).toEqual({ hash: sha256(a), status: "draft" });
    // 後から来た置き換えが DB を確定させたが、R2 に置けなかった
    storage.failures = 1;
    expect((await err({ html: b, post_id: v.post_id })).code).toBe("storage_failed");
    expect((await post(v.post_id)).gameHash).toBe(sha256(b));
    // 先の呼び出しがここで KV を書きに来る。R2 に無い内容を指してはいけない
    const puts = kv.puts;
    expect(await syncServe(db, kv, v.post_id)).toBe(false);
    expect(kv.puts).toBe(puts);
    expect(kv.values.get(v.post_id)).toEqual({ hash: sha256(a), status: "draft" });

    // 配信を止める方向（no）は R2 に無くても書く: 公開したが R2 に置けなかった投稿を非公開にする
    const c = gameHtml({ title: "公開で失敗" });
    storage.failures = 1;
    expect((await err({ html: c, publish: true })).code).toBe("storage_failed");
    const [p] = await db
      .select()
      .from(s.posts)
      .where(eq(s.posts.gameHash, sha256(c)));
    if (!p) throw new Error("投稿が無い");
    expect(kv.values.has(p.id)).toBe(false);
    await db.update(s.posts).set({ baseStatus: "unpublished" }).where(eq(s.posts.id, p.id));
    expect(await syncServe(db, kv, p.id)).toBe(true);
    expect(kv.values.get(p.id)).toEqual({ hash: sha256(c), status: "no" });
  });

  it("mc#A.2 R2 / KV が未設定なら not_configured で、何も書かない", async () => {
    const { storage: _s, ...noStorage } = deps;
    const r = await publishGame(noStorage, ME, { html: gameHtml() });
    expect(r.ok ? null : r.error.code).toBe("not_configured");
    expect(await count("posts")).toBe(0);
    expect(await count("users")).toBe(0);
  });

  // ---- 入力（mc#A.3、A.10 invalid） ---------------------------------------------------

  it.each([
    ["title が空白だけ", { title: "   " }],
    ["title が 41 文字", { title: "あ".repeat(41) }],
    ["prompt が 1001 文字", { prompt: "a".repeat(1001) }],
    ["html が空", { html: "" }],
  ])("R-mc.A10-1 %s は invalid で、何も書かない", async (_name, patch) => {
    const e = await err({ html: gameHtml(), ...patch });
    expect(e.code).toBe("invalid");
    expect(await count("posts")).toBe(0);
  });

  it("R-mc.A3-2 title は 40 文字、prompt は 1000 文字まで通る", async () => {
    const v = await ok({ html: gameHtml(), title: "あ".repeat(40), prompt: "a".repeat(1000) });
    expect((await post(v.post_id)).title).toBe("あ".repeat(40));
  });

  it("R-mc.A10-1 title を省略し <title> が 40 文字を超えるなら invalid（title を渡せば通る）", async () => {
    const html = gameHtml({ title: "あ".repeat(41) });
    expect((await err({ html })).code).toBe("invalid");
    expect(await count("posts")).toBe(0);
    expect((await ok({ html, title: "短い題" })).status).toBe("draft");
  });
});
