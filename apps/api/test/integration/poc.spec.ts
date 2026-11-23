/**
 * PoC の近道（`poc` ブランチだけ。docs/poc.md）。`POC_MODE=1` のときだけ効くことと、
 * サンプルをまとめて公開したら、そのままエンドレスの正規枠（ミスの閾値あり）で遊べることを見る。
 */

import { testUtils } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEVICE_ID_HEADER } from "../../src/actors.ts";
import { createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";
import { pocDistribution } from "../../src/poc.ts";
import { POC_SAMPLES } from "../../src/poc-samples.gen.ts";

const url = process.env.DATABASE_URL;
const dbSuite = url ? describe : describe.skip;
const BASE = "https://poc.example.test";
const NOW = new Date("2026-11-23T03:00:00Z");
const DEVICE = "AAAAAAAAAAAAAAAAAAAAAA";

describe("pocDistribution", () => {
  it("20 件、昇順、目標点が上位 1 割あたり（下から 18 件目）", () => {
    for (const target of [1, 6, 10, 85, 240]) {
      const d = pocDistribution(target);
      expect(d).toHaveLength(20);
      expect([...d].sort((a, b) => a - b)).toEqual(d);
      expect(d[17]).toBe(target);
      expect(d.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });
});

dbSuite("PoC モード", () => {
  let db: Db;
  let close: () => Promise<void>;
  let cookie: string;

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
  afterEach(() => {
    delete process.env.POC_MODE;
  });

  interface TestHelpers {
    createUser(u: { email: string; name: string }): { id: string };
    saveUser(u: { id: string }): Promise<unknown>;
    login(o: { userId: string }): Promise<{ cookies: { name: string; value: string }[] }>;
  }

  async function setup() {
    await db.execute(
      sql`truncate table sessions, runs, reports, likes, post_stats, tree_locks, moderation_actions, actors, posts, games, users, auth_user cascade`,
    );
    const auth = createAuth({
      baseURL: BASE,
      secret: "test-secret-".repeat(4),
      db,
      extraPlugins: [testUtils()],
    });
    const app = createApp({
      auth,
      baseURL: BASE,
      publish: {
        db,
        storage: { put: async () => {} },
        kv: { put: async () => {} },
        appOrigin: BASE,
        now: () => NOW,
      },
    });
    const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    const user = test.createUser({ email: "poc@example.test", name: "PoC" });
    await test.saveUser(user);
    const { cookies } = await test.login({ userId: user.id });
    // 新規アカウント（trust_score 10。本来は limited で、1 日 5 件まで）
    await db.insert(s.users).values({ id: user.id, handle: "poc", trustScore: 10 });
    cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return app;
  }
  beforeEach(() => {
    delete process.env.POC_MODE;
  });

  it("POC_MODE が無ければ、入口もまとめて公開も無い（404）", async () => {
    const app = await setup();
    expect((await app.request("/api/poc")).status).toBe(404);
    const res = await app.request("/api/poc/samples", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await db.select().from(s.posts)).toHaveLength(0);
  });

  it("POC_MODE=1: 未ログインは 401。ログインしていれば 12 本とも public・校正済み・仮の分布 20 件で公開される。もう一度押しても増えない", async () => {
    process.env.POC_MODE = "1";
    const app = await setup();
    expect((await app.request("/api/poc")).status).toBe(200);
    expect((await app.request("/api/poc/samples", { method: "POST" })).status).toBe(401);

    const push = async () => {
      const res = await app.request("/api/poc/samples", { method: "POST", headers: { cookie } });
      expect(res.status).toBe(200);
      return (
        (await res.json()) as {
          results: { name: string; ok: boolean; status?: string; error?: string }[];
        }
      ).results;
    };
    const results = await push();
    expect(results).toHaveLength(POC_SAMPLES.length);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["public"]));

    const posts = await db.select().from(s.posts);
    expect(posts).toHaveLength(12);
    expect(posts.every((p) => p.calibration === "calibrated" && p.baseStatus === "public")).toBe(
      true,
    );
    const stats = await db.select().from(s.postStats);
    expect(stats).toHaveLength(12);
    expect(stats.every((st) => st.n === 20 && st.scores.length === 20)).toBe(true);

    await push();
    expect(await db.select().from(s.posts)).toHaveLength(12);
  }, 60_000);

  it("POC_MODE=1: 公開した 12 本でエンドレスを作ると、全部が正規枠（新作扱いでなく、ミスの閾値がある）", async () => {
    process.env.POC_MODE = "1";
    const app = await setup();
    await app.request("/api/poc/samples", { method: "POST", headers: { cookie } });
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", [DEVICE_ID_HEADER]: DEVICE },
      body: JSON.stringify({ mode: "endless" }),
    });
    const body = (await res.json()) as {
      deck: { is_new: boolean; miss_below: number | null }[];
    };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.deck).toHaveLength(12);
    expect(body.deck.every((d) => !d.is_new && typeof d.miss_below === "number")).toBe(true);
  }, 60_000);
});
