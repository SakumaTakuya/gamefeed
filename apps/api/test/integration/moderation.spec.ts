/**
 * 運営の操作の integration テスト（moderation.md A.7）。いまあるのは `restore`（`post_id`）だけ:
 * `POST /api/moderation/posts/{id}/restore`（R-se.A8-1、R-mo.A7-1、R-mo.A7-2、R-12.2-6、R-mo.A5-1 の通報者 −2）。
 * Postgres と Better Auth は本物（ログインは testUtils）、R2 / KV は fake。
 */
import { TRUST_DELTA_REPORT_DISMISSED } from "@gamefeed/domain";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { type Auth, createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";
import { unpublishGame } from "../../src/my-games.ts";
import { type PostStatus, type PublishDeps, publishGame } from "../../src/publish.ts";
import { gameHtml } from "../helpers/game-html.ts";

const url = process.env.DATABASE_URL;
if (!url) console.warn("DATABASE_URL が未設定なので moderation の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const BASE = "https://app.example.test";
const NOW = new Date("2026-11-21T03:00:00Z");
const device = (i: number) => `dev${String(i).padStart(19, "0")}`;

type Account = { id: string; cookie: string };

dbSuite("POST /api/moderation/posts/{id}/restore（mo#A.7 の restore）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let auth: Auth;
  let deps: PublishDeps;
  let app: ReturnType<typeof createApp>;
  /** 運営（MODERATOR_IDS に入っている） */
  let owner: Account;
  /** 作者。trust_score 30（公開は public から） */
  let author: Account;
  /** 一般のログイン利用者（運営ではない） */
  let other: Account;
  let salt = 0;
  let kvPuts: { postId: string; status: string }[];
  let kvFails: boolean;
  let login: (name: string, trustScore: number | null) => Promise<Account>;

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
      sql`truncate table tree_locks, moderation_actions, reports, likes, post_stats, actors, posts, games, users, auth_user cascade`,
    );
    auth = createAuth({
      baseURL: BASE,
      secret: "test-secret-".repeat(4),
      db,
      extraPlugins: [testUtils()],
    });
    deps = {
      db,
      storage: { put: async () => {} },
      kv: {
        put: async (postId, value) => {
          if (kvFails) throw new Error("KV down");
          kvPuts.push({ postId, status: value.status });
        },
      },
      appOrigin: BASE,
      now: () => NOW,
    };
    const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    login = async (name: string, trustScore: number | null) => {
      const user = test.createUser({ email: `${name}@example.test`, name });
      await test.saveUser(user);
      const { cookies } = await test.login({ userId: user.id });
      if (trustScore !== null)
        await db.insert(s.users).values({ id: user.id, handle: name, trustScore });
      return { id: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    };
    owner = await login("owner", 10);
    author = await login("author", 30);
    other = await login("other", 10);
    app = createApp({ auth, baseURL: BASE, publish: deps, moderatorIds: [owner.id] });
    kvPuts = [];
    kvFails = false;
  });

  async function post(publish = true, userId = author.id): Promise<string> {
    const r = await publishGame(deps, userId, {
      html: gameHtml({ salt: String(++salt) }),
      publish,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value.post_id;
  }
  const report = (id: string, category: string, i: number, cookie?: string) =>
    app.request(`/api/posts/${id}/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": device(i),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ category }),
    });
  /** 新規 2 人（trust_score 10）の sexual で自動制限する（3 + 3 ≥ 5）。通報者を返す */
  async function autoRestricted(id: string, from = 0): Promise<[Account, Account]> {
    const a = await login(`r${from}`, 10);
    const b = await login(`r${from + 1}`, 10);
    await report(id, "sexual", from, a.cookie);
    await report(id, "sexual", from + 1, b.cookie);
    expect(await statusOf(id)).toBe("restricted");
    kvPuts = [];
    return [a, b];
  }
  const restore = (id: string, o: { cookie?: string; body?: unknown; app?: typeof app } = {}) =>
    (o.app ?? app).request(`/api/moderation/posts/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}) },
      body:
        typeof o.body === "string" ? o.body : JSON.stringify(o.body ?? { reason: "誤制限だった" }),
    });
  async function statusOf(id: string): Promise<PostStatus> {
    const rows = (await db.execute(
      sql`select status from post_status where id = ${id}`,
    )) as unknown as { status: PostStatus }[];
    return rows[0]?.status as PostStatus;
  }
  const postOf = async (id: string) =>
    (await db.select().from(s.posts).where(eq(s.posts.id, id)))[0];
  const userOf = async (id: string) =>
    (await db.select().from(s.users).where(eq(s.users.id, id)))[0];
  const resolutions = async (id: string) =>
    (await db.select().from(s.reports).where(eq(s.reports.postId, id)).orderBy(s.reports.id)).map(
      (r) => r.resolution,
    );
  const actions = () => db.select().from(s.moderationActions).orderBy(s.moderationActions.id);
  async function expectError(res: Response, status: number, error: string): Promise<void> {
    expect(await res.json()).toMatchObject({ error });
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }

  it("mo#A.9 通報が退けられた通報者の変化は −2", () => {
    expect(TRUST_DELTA_REPORT_DISMISSED).toBe(-2);
  });

  it("R-mo.A7-1 自動制限された投稿を運営が restore すると、制限が解け、open の通報が dismissed になり、監査行が 1 行残り、KV が ok に戻る", async () => {
    const id = await post();
    await autoRestricted(id);

    const res = await restore(id, { cookie: owner.cookie, body: { reason: "  誤制限だった  " } });
    expect(await res.json()).toEqual({ post_id: id, status: "public", dismissed: 2, served: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect((await postOf(id))?.indivRestricted).toBe(false);
    expect(await statusOf(id)).toBe("public");
    expect(await resolutions(id)).toEqual(["dismissed", "dismissed"]);
    // I6: 自動制限の行（moderator_id = NULL）の後に、運営の restore の行
    expect(
      (await actions()).map((a) => [a.moderatorId, a.kind, a.postId, a.userId, a.reason]),
    ).toEqual([
      [null, "restrict", id, null, expect.any(String)],
      [owner.id, "restore", id, null, "誤制限だった"],
    ]);
    expect((await actions())[1]?.createdAt).toEqual(NOW);
    expect(kvPuts).toEqual([{ postId: id, status: "ok" }]);
    // 読めるようになる
    expect((await app.request(`/api/posts/${id}`)).status).toBe(200);
  });

  it("R-mo.A7-1 退けた通報は数え直さない: restore の後の sexual 1 件ではまた制限されない", async () => {
    const id = await post();
    await autoRestricted(id);
    await restore(id, { cookie: owner.cookie });
    const c = await login("late", 10);
    await report(id, "sexual", 9, c.cookie);
    expect(await statusOf(id)).toBe("public");
    expect(await resolutions(id)).toEqual(["dismissed", "dismissed", "open"]);
  });

  it("R-se.A8-1 未ログインは unauthorized、運営でないログインは forbidden、MODERATOR_IDS が空なら誰でも forbidden。どれも何も変えない", async () => {
    const id = await post();
    await autoRestricted(id);

    await expectError(await restore(id), 401, "unauthorized");
    await expectError(await restore(id, { cookie: other.cookie }), 403, "forbidden");
    // 作者でも解けない
    await expectError(await restore(id, { cookie: author.cookie }), 403, "forbidden");
    const noMods = createApp({ auth, baseURL: BASE, publish: deps });
    await expectError(await restore(id, { cookie: owner.cookie, app: noMods }), 403, "forbidden");
    // 権限が無い人には、投稿があるかどうかも本文の形も答えない
    await expectError(
      await restore("01ARZ3NDEKTSV4RRFFQ69G5FAV", { cookie: other.cookie, body: {} }),
      403,
      "forbidden",
    );

    expect(await statusOf(id)).toBe("restricted");
    expect(await resolutions(id)).toEqual(["open", "open"]);
    expect(await actions()).toHaveLength(1);
    expect(kvPuts).toEqual([]);
  });

  it("R-se.A8-1 MODERATOR_IDS に入っていても users 行の無いログインは forbidden（監査行の moderator_id は users を指す）", async () => {
    const id = await post();
    await autoRestricted(id);
    const ghost = await login("ghost", null);
    const withGhost = createApp({ auth, baseURL: BASE, publish: deps, moderatorIds: [ghost.id] });
    await expectError(await restore(id, { cookie: ghost.cookie, app: withGhost }), 403, "forbidden");
    expect(await statusOf(id)).toBe("restricted");
  });

  it("R-mo.A5-1 通報者の trust_score は −2 ずつ（投稿ごとに 1 回）。匿名と users 行の無い通報者は対象外。作者と運営は変わらない", async () => {
    const id = await post();
    const [a, b] = await autoRestricted(id);
    // 制限済みの投稿にも通報は付く: 匿名、users 行の無いログイン、a の別の端末（同じ人の 2 件目）
    const player = await login("player", null);
    await report(id, "spam", 10);
    await report(id, "spam", 11, player.cookie);
    await report(id, "spam", 12, a.cookie);

    const res = await restore(id, { cookie: owner.cookie });
    expect(await res.json()).toMatchObject({ dismissed: 5 });
    expect((await userOf(a.id))?.trustScore).toBe(8);
    expect((await userOf(b.id))?.trustScore).toBe(8);
    expect((await userOf(author.id))?.trustScore).toBe(30);
    expect((await userOf(owner.id))?.trustScore).toBe(10);
    expect((await userOf(a.id))?.status).toBe("active");

    // 同じ投稿をもう一度制限して解いても、前に −2 された通報者は減らない（別の端末からの通報でも）
    await db.update(s.posts).set({ indivRestricted: true }).where(eq(s.posts.id, id));
    await report(id, "spam", 13, a.cookie);
    await restore(id, { cookie: owner.cookie });
    expect((await userOf(a.id))?.trustScore).toBe(8);
    expect(await resolutions(id)).toEqual(Array(6).fill("dismissed"));
  });

  it("R-mo.A5-1 R-mo.A5-2 通報者の trust_score は 0 で止まり、0 になったら post_restricted になる", async () => {
    const id = await post();
    const one = await login("one", 1);
    const two = await login("two", 2);
    const three = await login("three", 3);
    await report(id, "spam", 0, one.cookie);
    await report(id, "spam", 1, two.cookie);
    await report(id, "spam", 2, three.cookie);

    // 制限されていない投稿への restore は、通報を退けるだけ（mo#B.5）
    const res = await restore(id, { cookie: owner.cookie });
    expect(await res.json()).toEqual({ post_id: id, status: "public", dismissed: 3, served: true });
    expect(await userOf(one.id)).toMatchObject({ trustScore: 0, status: "post_restricted" });
    expect(await userOf(two.id)).toMatchObject({ trustScore: 0, status: "post_restricted" });
    expect(await userOf(three.id)).toMatchObject({ trustScore: 1, status: "active" });
  });

  it("R-mo.A7-1 upheld / dismissed 済みの通報は触らず、その通報者も変えない。ほかの投稿の通報も触らない", async () => {
    const id = await post();
    const elsewhere = await post();
    const [a, b] = await autoRestricted(id);
    await report(elsewhere, "spam", 0, a.cookie);
    const [first] = await db.select().from(s.reports).where(eq(s.reports.postId, id)).limit(1);
    await db
      .update(s.reports)
      .set({ resolution: "upheld" })
      .where(eq(s.reports.id, first?.id as number));

    const res = await restore(id, { cookie: owner.cookie });
    expect(await res.json()).toMatchObject({ dismissed: 1 });
    expect(await resolutions(id)).toEqual(["upheld", "dismissed"]);
    expect((await userOf(a.id))?.trustScore).toBe(10);
    expect((await userOf(b.id))?.trustScore).toBe(8);
    expect(await resolutions(elsewhere)).toEqual(["open"]);
  });

  it("R-mo.A7-2 制限中に calibrated になった limited は、restore と同時に public に昇格する。upheld が残る投稿は limited のまま", async () => {
    const newbie = await login("newbie", 10);
    const id = await post(true, newbie.id);
    const stays = await post(true, newbie.id);
    expect((await postOf(id))?.baseStatus).toBe("limited");
    await autoRestricted(id, 0);
    await autoRestricted(stays, 2);
    await db.update(s.posts).set({ calibration: "calibrated" });
    const [kept] = await db.select().from(s.reports).where(eq(s.reports.postId, stays)).limit(1);
    await db
      .update(s.reports)
      .set({ resolution: "upheld" })
      .where(eq(s.reports.id, kept?.id as number));

    expect(await (await restore(id, { cookie: owner.cookie })).json()).toMatchObject({
      status: "public",
    });
    expect((await postOf(id))?.baseStatus).toBe("public");
    expect(await (await restore(stays, { cookie: owner.cookie })).json()).toMatchObject({
      status: "limited",
    });
    expect((await postOf(stays))?.baseStatus).toBe("limited");
  });

  it("R-mo.A7-2 未校正の limited は restore しても limited のまま（昇格は校正済みだけ）", async () => {
    const newbie = await login("newbie", 10);
    const id = await post(true, newbie.id);
    await autoRestricted(id);
    expect(await (await restore(id, { cookie: owner.cookie })).json()).toMatchObject({
      status: "limited",
    });
    expect(kvPuts).toEqual([{ postId: id, status: "ok" }]);
  });

  it("対象は limited / public / unpublished。draft と removed は invalid_state、無い ID・形の違う ID は not_found で、何も書かない", async () => {
    const draft = await post(false);
    const removed = await post();
    await db.update(s.posts).set({ baseStatus: "removed" }).where(eq(s.posts.id, removed));
    kvPuts = [];

    await expectError(await restore(draft, { cookie: owner.cookie }), 409, "invalid_state");
    await expectError(await restore(removed, { cookie: owner.cookie }), 409, "invalid_state");
    await expectError(
      await restore("01ARZ3NDEKTSV4RRFFQ69G5FAV", { cookie: owner.cookie }),
      404,
      "not_found",
    );
    await expectError(await restore("nope", { cookie: owner.cookie }), 404, "not_found");
    expect(await actions()).toHaveLength(0);
    expect(kvPuts).toEqual([]);
  });

  it("unpublished の制限も解ける。投稿状態は unpublished のままで、配信は止まったまま", async () => {
    const id = await post();
    await autoRestricted(id);
    const r = await unpublishGame(deps, author.id, { post_id: id });
    expect(r.ok).toBe(true);
    kvPuts = [];

    const res = await restore(id, { cookie: owner.cookie });
    expect(await res.json()).toEqual({
      post_id: id,
      status: "unpublished",
      dismissed: 2,
      served: true,
    });
    expect((await postOf(id))?.indivRestricted).toBe(false);
    expect(kvPuts).toEqual([{ postId: id, status: "no" }]);
  });

  it("M4 の裏: ツリー制限は restore では解けない。個別制限だけが下り、投稿状態は restricted のまま", async () => {
    const id = await post();
    await autoRestricted(id);
    const [lock] = await db
      .insert(s.moderationActions)
      .values({ moderatorId: owner.id, kind: "restrict_tree", postId: id, reason: "t" })
      .returning();
    await db.insert(s.treeLocks).values({ rootPostId: id, actionId: lock?.id as number });

    const res = await restore(id, { cookie: owner.cookie });
    expect(await res.json()).toMatchObject({ status: "restricted", served: true });
    expect((await postOf(id))?.indivRestricted).toBe(false);
    expect(await db.select().from(s.treeLocks)).toHaveLength(1);
    expect(kvPuts).toEqual([{ postId: id, status: "no" }]);
  });

  it("reason は必須。無い・空白だけ・文字列でない・JSON でない本文は invalid_request で、何も変えない", async () => {
    const id = await post();
    await autoRestricted(id);
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 1 }, "not json", []]) {
      await expectError(await restore(id, { cookie: owner.cookie, body }), 400, "invalid_request");
    }
    expect(await statusOf(id)).toBe("restricted");
    expect(await actions()).toHaveLength(1);
  });

  it("R-se.A5-3 KV に書けなくても DB の復帰は確定し、served: false を返す。もう一度呼ぶと KV が書き直される", async () => {
    const id = await post();
    await autoRestricted(id);
    kvFails = true;
    const res = await restore(id, { cookie: owner.cookie });
    expect(await res.json()).toEqual({
      post_id: id,
      status: "public",
      dismissed: 2,
      served: false,
    });
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("public");

    kvFails = false;
    const again = await restore(id, { cookie: owner.cookie });
    expect(await again.json()).toEqual({
      post_id: id,
      status: "public",
      dismissed: 0,
      served: true,
    });
    expect(kvPuts).toEqual([{ postId: id, status: "ok" }]);
  }, 30_000);

  it("KV の変数が無い構成では not_configured で受け付けない（DB だけ戻って配信が止まったままになるのを防ぐ）", async () => {
    const id = await post();
    await autoRestricted(id);
    const { kv: _kv, ...withoutKv } = deps;
    const noKv = createApp({ auth, baseURL: BASE, publish: withoutKv, moderatorIds: [owner.id] });
    await expectError(await restore(id, { cookie: owner.cookie, app: noKv }), 503, "not_configured");
    expect(await statusOf(id)).toBe("restricted");
  });
});
