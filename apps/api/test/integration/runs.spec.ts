/**
 * 主体（actors）の upsert と `POST /api/runs`（エンドレスの山札）の integration テスト。
 * dm#A.1 / A.3、run#A.2 / A.3 / A.10、sc#A.8。R-dm.A1-1、R-run.A3-2、R-sc.A8-1。
 * Postgres と Better Auth は本物（ログインは testUtils）。乱数は seed から決まるものを渡す。
 * `device_id` の受け渡しなど仕様に未記載の点は #141 の案。
 */
import { ENDLESS_DECK_SIZE, ENDLESS_LIVES } from "@gamefeed/domain";
import { testUtils } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEVICE_ID_HEADER, parseDeviceId } from "../../src/actors.ts";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので runs の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const NOW = new Date("2026-11-14T03:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const DEVICE_A = "0123456789abcdef0123456789abcdef";
const DEVICE_B = "fedcba9876543210fedcba9876543210";

/** seed から決まる乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("device_id の形（dm#A.1、#141）", () => {
  it("128 bit の乱数の表記（hex 32 文字、base64url 22 文字、UUID）を受け、それ以外は null", () => {
    expect(DEVICE_ID_HEADER).toBe("x-device-id");
    expect(parseDeviceId(DEVICE_A)).toBe(DEVICE_A);
    expect(parseDeviceId("AAECAwQFBgcICQoLDA0ODw")).toBe("AAECAwQFBgcICQoLDA0ODw");
    expect(parseDeviceId("123e4567-e89b-42d3-a456-426614174000")).toBe(
      "123e4567-e89b-42d3-a456-426614174000",
    );
    for (const bad of [
      undefined,
      "",
      "short",
      "a".repeat(21),
      "a".repeat(65),
      `${"a".repeat(30)} x`,
      `${"a".repeat(30)}';--`,
    ]) {
      expect(parseDeviceId(bad)).toBeNull();
    }
  });
});

dbSuite("POST /api/runs（run#A.2、A.3）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let login: (email: string, withUsersRow?: boolean) => Promise<{ id: string; cookie: string }>;

  beforeAll(async () => {
    const h = createDb(url as string, { max: 1 });
    db = h.db;
    close = h.close;
    await resetDb(db);
    await migrateDb(db);
  }, 60_000);

  afterAll(async () => {
    await close?.();
  });

  interface TestHelpers {
    createUser(u: { email: string; name: string }): { id: string };
    saveUser(u: { id: string }): Promise<unknown>;
    login(o: { userId: string }): Promise<{ cookies: { name: string; value: string }[] }>;
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate table sessions, runs, reports, likes, post_stats, tree_locks, moderation_actions, actors, posts, games, users, auth_user cascade`,
    );
    const auth = createAuth({
      baseURL: BASE,
      secret: "test-secret-".repeat(4),
      db,
      extraPlugins: [testUtils()],
    });
    app = createApp({
      auth,
      baseURL: BASE,
      publish: { db, appOrigin: BASE, now: () => NOW },
      random: rng(1),
    });
    const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    login = async (email, withUsersRow = true) => {
      const user = test.createUser({ email, name: "Taku Sakuma" });
      await test.saveUser(user);
      const { cookies } = await test.login({ userId: user.id });
      if (withUsersRow) {
        await db.insert(s.users).values({ id: user.id, handle: email.split("@")[0] ?? "h" });
      }
      return { id: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    };
    // 投稿の作者とゲームの内容（全投稿で共用）
    await db.insert(s.users).values({ id: "author", handle: "author" });
    await db.insert(s.games).values({
      hash: "h-1",
      size: 1024,
      r2Key: "games/h-1.html",
      meta: {
        title: "押せ！",
        verb: "押せ！",
        input: "tap",
        duration_frames: 300,
        target: 12,
        deterministic: true,
        warnings: [],
      },
    });
  });

  // ---- fixtures -----------------------------------------------------------------

  type Calibration = "uncalibrated" | "calibrated" | "review" | "invalid";
  interface PostOpts {
    status?: "draft" | "limited" | "public" | "unpublished" | "removed";
    calibration?: Calibration;
    thumb?: boolean;
    restricted?: boolean;
  }
  async function seedPost(id: string, o: PostOpts = {}): Promise<string> {
    const status = o.status ?? "public";
    await db.insert(s.posts).values({
      id,
      userId: "author",
      gameHash: "h-1",
      title: id,
      prompt: "",
      treeId: id,
      depth: 0,
      calibration: o.calibration ?? "calibrated",
      thumbKey: (o.thumb ?? true) ? `thumbs/${id}.webp` : null,
      indivRestricted: o.restricted ?? false,
    });
    if (status !== "draft") {
      const first = status === "limited" ? "limited" : "public";
      await db.execute(
        sql`update posts set base_status = ${first}::base_status, published_at = now() where id = ${id}`,
      );
      if (status !== first) {
        await db.execute(
          sql`update posts set base_status = ${status}::base_status where id = ${id}`,
        );
      }
    }
    return id;
  }
  const seedPosts = (prefix: string, n: number, o: PostOpts = {}) =>
    Promise.all(Array.from({ length: n }, (_, i) => seedPost(`${prefix}${i}`, o)));

  interface RunBody {
    run_id: string;
    deck: { post_id: string; is_new: boolean }[];
  }
  async function postRuns(
    body: unknown,
    opts: { device?: string | null; cookie?: string; raw?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const device = opts.device === undefined ? DEVICE_A : opts.device;
    if (device !== null) headers[DEVICE_ID_HEADER] = device;
    if (opts.cookie) headers.cookie = opts.cookie;
    return app.request("/api/runs", {
      method: "POST",
      headers,
      body: opts.raw ?? JSON.stringify(body),
    });
  }
  async function created(res: Response): Promise<RunBody> {
    const body = (await res.json()) as RunBody;
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body;
  }
  async function expectError(res: Response, status: number, error: string): Promise<void> {
    expect(await res.json()).toMatchObject({ error });
    expect(res.status).toBe(status);
  }
  const actorRows = () => db.select().from(s.actors).orderBy(s.actors.createdAt, s.actors.id);
  const runRows = () => db.select().from(s.runs).orderBy(s.runs.id);
  /** 主体と、その主体が過去に引いたラン（山札と開始時刻）を直接入れる */
  async function seedPastRun(id: string, device: string, deck: string[], daysAgo: number) {
    const actorId = `actor-${device.slice(0, 4)}`;
    await db.insert(s.actors).values({ id: actorId, deviceId: device }).onConflictDoNothing();
    await db.insert(s.runs).values({
      id,
      mode: "endless",
      actorId,
      deck,
      newIndexes: [],
      lives: 3,
      startedAt: new Date(NOW.getTime() - daysAgo * DAY),
    });
  }

  // ---- 主体（dm#A.1、A.3、I17） ------------------------------------------------------

  describe("主体の upsert", () => {
    beforeEach(async () => {
      await seedPosts("c", 3);
    });

    it("R-dm.A1-1 同じ device_id で 2 回呼んでも actors は 1 行で、ランは同じ主体に付く", async () => {
      await created(await postRuns({ mode: "endless" }));
      await created(await postRuns({ mode: "endless" }));
      const actors = await actorRows();
      expect(actors).toHaveLength(1);
      expect(actors[0]).toMatchObject({ deviceId: DEVICE_A, userId: null });
      expect(actors[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      const runs = await runRows();
      expect(runs.map((r) => r.actorId)).toEqual([actors[0]?.id, actors[0]?.id]);
    });

    it("R-dm.A1-1 別の device_id は別の主体", async () => {
      await created(await postRuns({ mode: "endless" }, { device: DEVICE_A }));
      await created(await postRuns({ mode: "endless" }, { device: DEVICE_B }));
      const actors = await actorRows();
      expect(actors.map((a) => a.deviceId).sort()).toEqual([DEVICE_A, DEVICE_B].sort());
      expect(new Set((await runRows()).map((r) => r.actorId)).size).toBe(2);
    });

    it("R-dm.A1-1 X-Device-Id が無い・形式外なら 400 invalid_device で、主体もランも作らない", async () => {
      await expectError(
        await postRuns({ mode: "endless" }, { device: null }),
        400,
        "invalid_device",
      );
      await expectError(
        await postRuns({ mode: "endless" }, { device: "short" }),
        400,
        "invalid_device",
      );
      await expectError(
        await postRuns({ mode: "endless" }, { device: "x".repeat(65) }),
        400,
        "invalid_device",
      );
      expect(await actorRows()).toEqual([]);
      expect(await runRows()).toEqual([]);
    });

    it("R-dm.A1-1 ログイン済みで users 行があれば user_id が埋まる。匿名で作った主体も後から埋まる", async () => {
      await created(await postRuns({ mode: "endless" }));
      expect((await actorRows())[0]?.userId).toBeNull();
      const me = await login("me@example.test");
      await created(await postRuns({ mode: "endless" }, { cookie: me.cookie }));
      const actors = await actorRows();
      expect(actors).toHaveLength(1);
      expect(actors[0]?.userId).toBe(me.id);
    });

    it("R-dm.A1-1 一度埋まった user_id は、別の利用者で呼んでも変わらない（I17）", async () => {
      const me = await login("me@example.test");
      const other = await login("other@example.test");
      await created(await postRuns({ mode: "endless" }, { cookie: me.cookie }));
      await created(await postRuns({ mode: "endless" }, { cookie: other.cookie }));
      // ログアウトして匿名で呼んでも消えない
      await created(await postRuns({ mode: "endless" }));
      const actors = await actorRows();
      expect(actors).toHaveLength(1);
      expect(actors[0]?.userId).toBe(me.id);
      expect(await runRows()).toHaveLength(3);
    });

    it("R-dm.A1-1 users 行のない利用者（遊ぶだけでログインした人）では埋めない", async () => {
      const player = await login("player@example.test", false);
      await created(await postRuns({ mode: "endless" }, { cookie: player.cookie }));
      expect((await actorRows())[0]?.userId).toBeNull();
    });

    it("R-dm.A1-1 同じ device_id の同時の初回アクセスでも主体は 1 行", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => postRuns({ mode: "endless" })),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(await actorRows()).toHaveLength(1);
      expect(await runRows()).toHaveLength(5);
    });
  });

  // ---- 山札（run#A.2、A.3、A.10、sc#A.8） ----------------------------------------------

  describe("エンドレスの山札", () => {
    it("R-run.A3-2 校正済み 11 本 + 新作枠 1 本の山札を確定し、run_id と山札を返す。runs の行と一致する", async () => {
      await seedPosts("c", 20);
      await seedPosts("u", 3, { calibration: "uncalibrated" });
      const res = await postRuns({ mode: "endless" });
      const body = await created(res);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(body.run_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(body.deck).toHaveLength(ENDLESS_DECK_SIZE);
      expect(new Set(body.deck.map((d) => d.post_id)).size).toBe(ENDLESS_DECK_SIZE);
      const news = body.deck.filter((d) => d.is_new);
      expect(news).toHaveLength(1);
      expect(news[0]?.post_id).toMatch(/^u/);
      expect(body.deck.filter((d) => !d.is_new).every((d) => d.post_id.startsWith("c"))).toBe(true);

      const [run, ...rest] = await runRows();
      expect(rest).toEqual([]);
      const [actor] = await actorRows();
      expect(run).toMatchObject({
        id: body.run_id,
        mode: "endless",
        themeId: null,
        date: null,
        actorId: actor?.id,
        deck: body.deck.map((d) => d.post_id),
        newIndexes: body.deck.flatMap((d, i) => (d.is_new ? [i] : [])),
        fromRun: null,
        lives: ENDLESS_LIVES,
        reached: null,
        avgDeviation: null,
        symbols: null,
        ended: null,
        recorded: false,
        endedAt: null,
      });
      expect(run?.startedAt.toISOString()).toBe(NOW.toISOString());
      // ラン作成では手番を発行しない（next が発行する。#127）
      expect(await db.select().from(s.sessions)).toEqual([]);
    });

    it("R-run.A3-2 新作枠の位置と抽選はサーバの乱数で決まり、呼ぶたびに変わる（run#A.10）", async () => {
      await seedPosts("c", 30);
      await seedPosts("u", 3, { calibration: "uncalibrated" });
      const decks: RunBody[] = [];
      // 別の端末で呼ぶ（同じ端末だと直近に引いたものが除かれる）
      for (let i = 0; i < 8; i++) {
        decks.push(
          await created(await postRuns({ mode: "endless" }, { device: `${DEVICE_A}${i}` })),
        );
      }
      expect(new Set(decks.map((d) => d.deck.map((x) => x.post_id).join(","))).size).toBe(8);
      expect(new Set(decks.map((d) => d.deck.findIndex((x) => x.is_new))).size).toBeGreaterThan(2);
    });

    it("R-sc.A8-1 校正状態 4 つ × public / limited: uncalibrated は新作扱い、public の calibrated は正規枠、ほかは入らない", async () => {
      await seedPost("pub-unc", { status: "public", calibration: "uncalibrated" });
      await seedPost("pub-cal", { status: "public", calibration: "calibrated" });
      await seedPost("pub-rev", { status: "public", calibration: "review" });
      await seedPost("pub-inv", { status: "public", calibration: "invalid" });
      await seedPost("lim-unc", { status: "limited", calibration: "uncalibrated" });
      await seedPost("lim-cal", { status: "limited", calibration: "calibrated" });
      await seedPost("lim-rev", { status: "limited", calibration: "review" });
      await seedPost("lim-inv", { status: "limited", calibration: "invalid" });
      const { deck } = await created(await postRuns({ mode: "endless" }));
      expect([...deck].sort((a, b) => (a.post_id < b.post_id ? -1 : 1))).toEqual([
        { post_id: "lim-unc", is_new: true },
        { post_id: "pub-cal", is_new: false },
        { post_id: "pub-unc", is_new: true },
      ]);
    });

    it("R-sc.A8-1 public / limited 以外（draft・unpublished・removed・制限中）とサムネのない未校正は入らない", async () => {
      await seedPost("ok", {});
      for (const calibration of ["calibrated", "uncalibrated"] as const) {
        await seedPost(`draft-${calibration}`, { status: "draft", calibration });
        await seedPost(`unpublished-${calibration}`, { status: "unpublished", calibration });
        await seedPost(`removed-${calibration}`, { status: "removed", calibration });
        await seedPost(`restricted-${calibration}`, { restricted: true, calibration });
      }
      // 公開直後のジョブがまだ通っていない（thumb_key が NULL）未校正は新作枠に入らない（mc#A.9）
      await seedPost("no-thumb", { calibration: "uncalibrated", thumb: false });
      // ツリー制限の下にある投稿も入らない（dm#A.4 post_status）
      await seedPost("locked", {});
      const [action] = await db
        .insert(s.moderationActions)
        .values({ kind: "restrict_tree", postId: "locked", reason: "test" })
        .returning({ id: s.moderationActions.id });
      await db.insert(s.treeLocks).values({ rootPostId: "locked", actionId: action?.id as number });

      const { deck } = await created(await postRuns({ mode: "endless" }));
      expect(deck).toEqual([{ post_id: "ok", is_new: false }]);
    });

    it("R-sc.A8-1 校正済みが足りなければ未校正で埋め、埋めた位置も is_new。それでも足りなければ短くなる（#123）", async () => {
      await seedPosts("c", 5);
      await seedPosts("u", 20, { calibration: "uncalibrated" });
      const full = await created(await postRuns({ mode: "endless" }, { device: DEVICE_A }));
      expect(full.deck).toHaveLength(12);
      expect(full.deck.filter((d) => d.is_new)).toHaveLength(7);
      expect(full.deck.every((d) => d.is_new === d.post_id.startsWith("u"))).toBe(true);

      await db.execute(sql`delete from runs`);
      await db.execute(sql`delete from posts where id like 'u%' and id <> 'u0'`);
      const short = await created(await postRuns({ mode: "endless" }, { device: DEVICE_B }));
      expect(short.deck).toHaveLength(6);
      expect(short.deck.filter((d) => d.is_new)).toEqual([{ post_id: "u0", is_new: true }]);
    });

    it("R-sc.A8-1 未校正が 0 本なら新作枠なしで校正済みだけの 12 本", async () => {
      await seedPosts("c", 20);
      const { deck } = await created(await postRuns({ mode: "endless" }));
      expect(deck).toHaveLength(12);
      expect(deck.some((d) => d.is_new)).toBe(false);
      expect((await runRows())[0]?.newIndexes).toEqual([]);
    });

    it("R-sc.A8-1 出せるゲームが 0 本なら 409 no_games で、ランを作らない（主体は作る）", async () => {
      await seedPost("draft", { status: "draft" });
      await seedPost("invalid", { calibration: "invalid" });
      await expectError(await postRuns({ mode: "endless" }), 409, "no_games");
      expect(await runRows()).toEqual([]);
      expect(await actorRows()).toHaveLength(1);
    });
  });

  describe("直近 7 日に引いたゲームの除外（run#A.2）", () => {
    const drawn = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];

    it("R-sc.A8-1 その主体が直近 7 日に引いたゲームは山札に入らない", async () => {
      await seedPosts("c", 20);
      await seedPastRun("past", DEVICE_A, drawn, 6.9);
      const { deck } = await created(await postRuns({ mode: "endless" }));
      expect(deck).toHaveLength(12);
      expect(deck.map((d) => d.post_id).filter((p) => drawn.includes(p))).toEqual([]);
    });

    it("R-sc.A8-1 7 日より前に引いたもの・ほかの主体が引いたものは除かない", async () => {
      await seedPosts("c", 12);
      await seedPastRun("old", DEVICE_A, drawn, 7.1);
      await seedPastRun("theirs", DEVICE_B, drawn, 1);
      const { deck } = await created(await postRuns({ mode: "endless" }));
      expect(deck.map((d) => d.post_id).sort()).toEqual(
        Array.from({ length: 12 }, (_, i) => `c${i}`).sort(),
      );
    });

    it("R-sc.A8-1 POST /runs で引いた山札は、同じ主体の次のランから除かれる", async () => {
      await seedPosts("c", 24);
      const first = await created(await postRuns({ mode: "endless" }));
      const second = await created(await postRuns({ mode: "endless" }));
      const a = first.deck.map((d) => d.post_id);
      const b = second.deck.map((d) => d.post_id);
      expect(b.filter((p) => a.includes(p))).toEqual([]);
      expect([...a, ...b].sort()).toEqual(Array.from({ length: 24 }, (_, i) => `c${i}`).sort());
    });

    it("R-sc.A8-1 除外で 12 本組めなくなるときは、引いた日が古いものから除外を外す", async () => {
      // 引いていないのは c0〜c8 の 9 本。足りない 3 本を、引いた日（同じゲームは新しい方）が古い順に戻す
      await seedPosts("c", 15);
      await seedPastRun("r6", DEVICE_A, ["c9"], 6);
      await seedPastRun("r5", DEVICE_A, ["c10", "c9"], 5.5);
      await seedPastRun("r4", DEVICE_A, ["c11"], 4);
      await seedPastRun("r3", DEVICE_A, ["c12", "c10"], 3);
      await seedPastRun("r1", DEVICE_A, ["c13", "c14"], 1);
      // c9 は 5.5 日前、c10 は 3 日前に引き直しているので、古い順は c9（5.5）、c11（4）、c10 と c12（3）
      const { deck } = await created(await postRuns({ mode: "endless" }));
      const ids = deck.map((d) => d.post_id);
      expect(ids).toHaveLength(12);
      for (let i = 0; i <= 8; i++) expect(ids).toContain(`c${i}`);
      expect(ids).toContain("c9");
      expect(ids).toContain("c11");
      expect(ids.filter((p) => p === "c10" || p === "c12")).toHaveLength(1);
      expect(ids.filter((p) => p === "c13" || p === "c14")).toEqual([]);
    });
  });

  describe("from_run（共有リンクからの再現。run#A.3、A.14）", () => {
    it("R-run.A3-2 同じ山札（並びと新作扱いの位置）の新しいランができる。別の主体でもよい", async () => {
      await seedPosts("c", 30);
      await seedPosts("u", 3, { calibration: "uncalibrated" });
      const original = await created(await postRuns({ mode: "endless" }, { device: DEVICE_A }));
      const copy = await created(
        await postRuns({ mode: "endless", from_run: original.run_id }, { device: DEVICE_B }),
      );
      expect(copy.run_id).not.toBe(original.run_id);
      expect(copy.deck).toEqual(original.deck);
      const runs = await runRows();
      const src = runs.find((r) => r.id === original.run_id);
      const dst = runs.find((r) => r.id === copy.run_id);
      expect(dst).toMatchObject({
        mode: "endless",
        deck: src?.deck,
        newIndexes: src?.newIndexes,
        fromRun: original.run_id,
        lives: ENDLESS_LIVES,
        ended: null,
      });
      expect(dst?.actorId).not.toBe(src?.actorId);
    });

    it("R-run.A3-2 同じ主体が自分のランを写しても同じ山札（直近 7 日の除外を掛けない）。写しの写しも元の山札", async () => {
      await seedPosts("c", 30);
      const original = await created(await postRuns({ mode: "endless" }));
      const copy = await created(await postRuns({ mode: "endless", from_run: original.run_id }));
      const again = await created(await postRuns({ mode: "endless", from_run: copy.run_id }));
      expect(copy.deck).toEqual(original.deck);
      expect(again.deck).toEqual(original.deck);
      expect((await runRows()).find((r) => r.id === again.run_id)?.fromRun).toBe(copy.run_id);
    });

    it("R-run.A3-2 元のランの後で状態が変わった投稿も山札に残る（出すかは next が決める。mo#A.3）", async () => {
      await seedPosts("c", 12);
      const original = await created(await postRuns({ mode: "endless" }));
      await db.execute(sql`update posts set base_status = 'removed' where id = 'c0'`);
      const copy = await created(
        await postRuns({ mode: "endless", from_run: original.run_id }, { device: DEVICE_B }),
      );
      expect(copy.deck).toEqual(original.deck);
    });

    it("R-run.A3-2 無いランの from_run は 404 run_not_found で、ランを作らない", async () => {
      await seedPosts("c", 12);
      await expectError(
        await postRuns({ mode: "endless", from_run: "01M782MV00TMYMTHTGG5C6KS3T" }),
        404,
        "run_not_found",
      );
      expect(await runRows()).toEqual([]);
    });

    it("R-run.A3-2 デイリーのランを from_run にしたエンドレスは 404 run_not_found", async () => {
      await seedPosts("c", 12);
      await db.insert(s.themes).values({ id: "t-1", slug: "x", title: "x" });
      await db.insert(s.actors).values({ id: "a-daily", deviceId: "dev-daily" });
      await db.insert(s.runs).values({
        id: "daily-1",
        mode: "daily",
        themeId: "t-1",
        date: "2026-11-14",
        actorId: "a-daily",
        deck: Array.from({ length: 10 }, (_, i) => `c${i}`),
        newIndexes: [0],
        lives: 0,
      });
      await expectError(
        await postRuns({ mode: "endless", from_run: "daily-1" }),
        404,
        "run_not_found",
      );
    });
  });

  describe("不正な入力", () => {
    beforeEach(async () => {
      await seedPosts("c", 3);
    });

    it("R-run.A3-2 mode が無い・endless 以外（daily は W4）・本文が JSON でない・from_run が文字列でないなら 400 invalid_request", async () => {
      await expectError(await postRuns({}), 400, "invalid_request");
      await expectError(await postRuns({ mode: "daily", theme: "x" }), 400, "invalid_request");
      await expectError(await postRuns({ mode: "sprint" }), 400, "invalid_request");
      await expectError(await postRuns(null, { raw: "not json" }), 400, "invalid_request");
      await expectError(await postRuns(null, { raw: "[]" }), 400, "invalid_request");
      await expectError(await postRuns(null, { raw: "null" }), 400, "invalid_request");
      await expectError(await postRuns({ mode: "endless", from_run: 5 }), 400, "invalid_request");
      expect(await runRows()).toEqual([]);
      // 入力の検査は主体の upsert より前
      expect(await actorRows()).toEqual([]);
    });

    it("POST 以外は受けない", async () => {
      const res = await app.request("/api/runs", { headers: { [DEVICE_ID_HEADER]: DEVICE_A } });
      expect(res.status).toBe(404);
    });
  });
});
