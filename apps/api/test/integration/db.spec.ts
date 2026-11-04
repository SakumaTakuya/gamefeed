/**
 * spec#12 データモデルの integration テスト。
 *
 * 空の Postgres にマイグレーションを当て、DB 制約（CHECK / UNIQUE / FK / トリガー / ビュー）が
 * 仕様どおりに効くことを確かめる。DB は本物（docs/testing.md）。CI は Postgres service container、
 * ローカルは DATABASE_URL を指す Postgres。
 *
 * 各テストはトランザクションの中で実行して最後に巻き戻す（docs/testing.md 4. integration）。
 */

import { DURATION_MAX, DURATION_MIN } from "@gamefeed/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn(
    "DATABASE_URL が未設定なので DB の integration テストを skip します（CI では必ず設定する）",
  );
}

const dbSuite = url ? describe : describe.skip;

dbSuite("spec#12 データモデル", () => {
  let db: Db;
  let close: () => Promise<void>;

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

  /** テスト本体をトランザクション内で実行し、終わったら巻き戻す。 */
  async function rolledBack(fn: (tx: Db) => Promise<void>): Promise<void> {
    await db
      .transaction(async (tx) => {
        await fn(tx as unknown as Db);
        tx.rollback();
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.constructor.name === "TransactionRollbackError") return;
        throw e;
      });
  }

  /**
   * drizzle は DB のエラーを DrizzleQueryError（message は SQL 文）で包む。
   * 制約名やトリガーの文言で判定するため、元の Postgres のエラーを投げ直す。
   */
  function dbError(p: Promise<unknown>): Promise<never> {
    return p.then(
      () => {
        throw new Error("DB が拒否するはずのクエリが通った");
      },
      (e: unknown) => {
        throw e instanceof Error && e.cause instanceof Error ? e.cause : e;
      },
    );
  }

  // ---- fixtures ---------------------------------------------------------------

  async function seedUser(tx: Db, id = "u-1", handle = "alice") {
    await tx.insert(s.users).values({ id, handle });
    return id;
  }
  async function seedGame(tx: Db, hash = "h-1", extra: Partial<typeof s.games.$inferInsert> = {}) {
    await tx.insert(s.games).values({
      hash,
      size: 1024,
      s3Key: `games/${hash}.html`,
      analysis: {},
      verb: "押せ！",
      input: "tap",
      durationFrames: 300,
      ...extra,
    });
    return hash;
  }
  async function seedPost(tx: Db, id = "p-1", extra: Partial<typeof s.posts.$inferInsert> = {}) {
    await tx.insert(s.posts).values({
      id,
      userId: "u-1",
      gameHash: "h-1",
      title: "押せ！",
      prompt: "ボタンを押すだけ",
      treeId: id,
      depth: 0,
      ...extra,
    });
    return id;
  }
  async function seedAll(tx: Db) {
    await seedUser(tx);
    await seedGame(tx);
    await seedPost(tx);
  }

  // ---- R-12.1 テーブル ---------------------------------------------------------

  describe("R-12.1-1 全テーブルと列挙型がマイグレーションで作られる", () => {
    it("spec#12.1 の 10 テーブルと spec#12.4 の 2 テーブルが存在する", async () => {
      const r = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      );
      const names = r.map((x) => x.table_name);
      for (const t of [
        "users",
        "games",
        "posts",
        "sessions",
        "reports",
        "moderation_actions",
        "fork_tokens",
        "tree_locks",
        "assets",
        "post_assets",
        "themes",
        "runs",
      ]) {
        expect(names, `テーブル ${t}`).toContain(t);
      }
    });

    it("列挙型は spec#12.1 の値をそのまま持つ", async () => {
      const r = await db.execute<{ typname: string; labels: string[] }>(
        sql`select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
            from pg_type t join pg_enum e on e.enumtypid = t.oid
            group by t.typname`,
      );
      const enums = Object.fromEntries(r.map((x) => [x.typname, x.labels]));
      expect(enums.user_status).toEqual(["active", "post_restricted", "banned"]);
      expect(enums.base_status).toEqual(["pending", "limited", "public", "removed", "expired"]);
      expect(enums.session_state).toEqual(["open", "submitted", "abandoned"]);
      expect(enums.session_mode).toEqual(["play", "replay"]);
      expect(enums.verdict).toEqual(["provisional", "accepted", "rejected", "flagged"]);
      expect(enums.report_resolution).toEqual(["open", "upheld", "dismissed"]);
      expect(enums.moderation_kind).toEqual([
        "restrict",
        "restore",
        "remove",
        "restrict_tree",
        "restore_tree",
        "ban_user",
      ]);
      expect(enums.asset_type).toEqual(["image", "sfx", "bgm", "model", "font"]);
      expect(enums.asset_source).toEqual(["library", "user"]);
      expect(enums.theme_status).toEqual(["draft", "open", "closed"]);
    });

    it("マイグレーションは冪等（2 回目は何もしない）", async () => {
      await migrateDb(db);
      const r = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
      );
      expect(Number(r[0]?.n)).toBeGreaterThan(0);
    });
  });

  describe("R-12.1-2 一意制約", () => {
    it("users.handle は一意", async () => {
      await rolledBack(async (tx) => {
        await seedUser(tx, "u-1", "alice");
        await expect(dbError(seedUser(tx, "u-2", "alice"))).rejects.toThrow(/unique/i);
      });
    });

    it("reports は (post_id, reporter_id) で一意（同一人物は同じ投稿を 1 回だけ通報できる）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedUser(tx, "u-2", "bob");
        const row = { postId: "p-1", reporterId: "u-2", category: "spam", weight: 1 };
        await tx.insert(s.reports).values(row);
        await expect(dbError(tx.insert(s.reports).values(row))).rejects.toThrow(/unique/i);
      });
    });

    it("post_assets は (post_id, name) で一意", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.assets).values({
          hash: "a-1",
          type: "image",
          size: 100,
          s3Key: "assets/a-1.webp",
          source: "library",
          scan: {},
        });
        const row = { postId: "p-1", name: "hero.webp", assetHash: "a-1", required: false };
        await tx.insert(s.postAssets).values(row);
        await expect(dbError(tx.insert(s.postAssets).values(row))).rejects.toThrow(/unique/i);
      });
    });
  });

  describe("R-12.1-3 posts.parent_id は posts.id への外部キーで、削除は RESTRICT", () => {
    it("子がある投稿は削除できない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedPost(tx, "p-2", { parentId: "p-1", treeId: "p-1", depth: 1 });
        await expect(dbError(tx.execute(sql`delete from posts where id = 'p-1'`))).rejects.toThrow(
          /foreign key|violates/i,
        );
      });
    });

    it("存在しない親は指せない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await expect(
          dbError(seedPost(tx, "p-2", { parentId: "nope", treeId: "nope", depth: 1 })),
        ).rejects.toThrow(/foreign key|violates/i);
      });
    });
  });

  describe("R-12.1-4 sessions.submitted_at は state = submitted のときだけ非 NULL（CHECK）", () => {
    it("open のセッションは submitted_at が NULL で入る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.sessions).values({
          id: "s-1",
          postId: "p-1",
          seed: 2891734521,
          mode: "play",
          state: "open",
        });
      });
    });

    it("submitted なのに submitted_at が NULL なら拒否", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await expect(
          dbError(
            tx.insert(s.sessions).values({
              id: "s-1",
              postId: "p-1",
              seed: 1,
              mode: "play",
              state: "submitted",
            }),
          ),
        ).rejects.toThrow(/check/i);
      });
    });

    it("open なのに submitted_at があれば拒否", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await expect(
          dbError(
            tx.insert(s.sessions).values({
              id: "s-1",
              postId: "p-1",
              seed: 1,
              mode: "play",
              state: "open",
              submittedAt: new Date(),
            }),
          ),
        ).rejects.toThrow(/check/i);
      });
    });

    it("score は 0 以上（spec#10.4）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await expect(
          dbError(
            tx.insert(s.sessions).values({
              id: "s-1",
              postId: "p-1",
              seed: 1,
              mode: "play",
              state: "open",
              score: -1,
            }),
          ),
        ).rejects.toThrow(/check/i);
      });
    });
  });

  describe("R-12.1-5 表示用 status は base_status・indiv_restricted・tree_locks から導出するビュー", () => {
    async function statusOf(tx: Db, id: string): Promise<string | undefined> {
      const r = await tx.execute<{ status: string }>(
        sql`select status from post_status where id = ${id}`,
      );
      return r[0]?.status;
    }

    it("public で制限なしなら public", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(
          sql`update posts set base_status = 'public', showcase_key = 'showcase/p-1.json.gz' where id = 'p-1'`,
        );
        expect(await statusOf(tx, "p-1")).toBe("public");
      });
    });

    it("indiv_restricted なら restricted", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(
          sql`update posts set base_status = 'public', showcase_key = 'k', indiv_restricted = true where id = 'p-1'`,
        );
        expect(await statusOf(tx, "p-1")).toBe("restricted");
      });
    });

    it("祖先が tree_locks にあれば子孫も restricted、根の制限を外せば戻る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedPost(tx, "p-2", { parentId: "p-1", treeId: "p-1", depth: 1 });
        await seedPost(tx, "p-3", { parentId: "p-2", treeId: "p-1", depth: 2 });
        await tx.execute(sql`update posts set base_status = 'public', showcase_key = 'k'`);
        await tx.insert(s.moderationActions).values({
          id: 1,
          actorId: "u-1",
          kind: "restrict_tree",
          postId: "p-1",
          reason: "test",
        });
        await tx.insert(s.treeLocks).values({ rootPostId: "p-1", actionId: 1 });
        expect(await statusOf(tx, "p-1")).toBe("restricted");
        expect(await statusOf(tx, "p-2")).toBe("restricted");
        expect(await statusOf(tx, "p-3")).toBe("restricted");

        await tx.delete(s.treeLocks);
        expect(await statusOf(tx, "p-3")).toBe("public");
      });
    });

    it("removed / expired / pending は制限の有無にかかわらずそのまま", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        expect(await statusOf(tx, "p-1")).toBe("pending");
        await tx.execute(
          sql`update posts set base_status = 'removed', indiv_restricted = true where id = 'p-1'`,
        );
        expect(await statusOf(tx, "p-1")).toBe("removed");
      });
    });
  });

  // ---- R-12.2 不変条件 ---------------------------------------------------------

  describe("R-12.2-1 I1: parent_id は更新不可（トリガー）", () => {
    // 1 トランザクション内で 2 回エラーを起こすと 2 回目は "transaction is aborted" になるので分ける
    it.each([
      ["別の親", sql`update posts set parent_id = 'p-2' where id = 'p-3'`],
      ["NULL", sql`update posts set parent_id = null where id = 'p-3'`],
    ])("parent_id を %s に書き換えると拒否される", async (_, q) => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedPost(tx, "p-2");
        await seedPost(tx, "p-3", { parentId: "p-1", treeId: "p-1", depth: 1 });
        await expect(dbError(tx.execute(q))).rejects.toThrow(/parent_id/);
      });
    });

    it("parent_id 以外の更新は通る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(sql`update posts set title = '新しい題' where id = 'p-1'`);
      });
    });
  });

  describe("R-12.2-4 I4: limited / public なら showcase_key が非 NULL（CHECK）", () => {
    it.each(["limited", "public"])("%s で showcase_key が NULL なら拒否", async (st) => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await expect(
          dbError(
            tx.execute(sql`update posts set base_status = ${st}::base_status where id = 'p-1'`),
          ),
        ).rejects.toThrow(/check/i);
      });
    });

    it("pending なら showcase_key は NULL でよい", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
      });
    });
  });

  describe("R-12.2-5 I5: removed / expired からの遷移は存在しない（トリガー）", () => {
    it.each(["removed", "expired"])("%s から public に戻せない", async (st) => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(sql`update posts set base_status = ${st}::base_status where id = 'p-1'`);
        await expect(
          dbError(
            tx.execute(
              sql`update posts set base_status = 'public', showcase_key = 'k' where id = 'p-1'`,
            ),
          ),
        ).rejects.toThrow(/removed|expired|終端/);
      });
    });

    it("removed のまま他の列を更新するのは通る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(sql`update posts set base_status = 'removed' where id = 'p-1'`);
        await tx.execute(sql`update posts set title = 'x' where id = 'p-1'`);
      });
    });
  });

  describe("R-12.2-3 I3: tree_locks の action_id は moderation_actions を指す（FK）", () => {
    it("監査行のない tree_lock は入らない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await expect(
          dbError(tx.insert(s.treeLocks).values({ rootPostId: "p-1", actionId: 999 })),
        ).rejects.toThrow(/foreign key|violates/i);
      });
    });
  });

  // ---- R-12.4 ミクロゲーム対応の追加分 ----------------------------------------------

  describe("R-12.4-1 games.duration_frames ∈ [180, 480]（CHECK）", () => {
    it.each([DURATION_MIN, DURATION_MAX])("%i は受理", async (n) => {
      await rolledBack(async (tx) => {
        await seedGame(tx, `h-${n}`, { durationFrames: n });
      });
    });

    it.each([DURATION_MIN - 1, DURATION_MAX + 1])("%i は拒否", async (n) => {
      await rolledBack(async (tx) => {
        await expect(dbError(seedGame(tx, `h-${n}`, { durationFrames: n }))).rejects.toThrow(
          /check/i,
        );
      });
    });

    it("verb / input / duration_frames は静的解析前（pending）は NULL でよい", async () => {
      await rolledBack(async (tx) => {
        await seedGame(tx, "h-raw", { verb: null, input: null, durationFrames: null });
      });
    });

    it("games.theme_id は themes への外部キー。NULL はフリー", async () => {
      await rolledBack(async (tx) => {
        await seedUser(tx);
        await tx.insert(s.themes).values({
          id: "t-1",
          title: "フリー",
          prompt: "何でも",
          status: "open",
          createdBy: "u-1",
        });
        await seedGame(tx, "h-t", { themeId: "t-1" });
        await seedGame(tx, "h-free", { themeId: null });
        await expect(dbError(seedGame(tx, "h-bad", { themeId: "nope" }))).rejects.toThrow(
          /foreign key|violates/i,
        );
      });
    });
  });

  describe("R-12.4-2 runs: cleared ≤ total、results の長さ ≤ total（CHECK）", () => {
    const base = { id: "r-1", seed: 42, gameIds: ["p-1", "p-2"], total: 2, startedAt: new Date() };

    it("cleared = total、results が total 以下は受理", async () => {
      await rolledBack(async (tx) => {
        await tx.insert(s.runs).values({ ...base, results: ["win", "win"], cleared: 2 });
        await tx.insert(s.runs).values({ ...base, id: "r-2", results: ["win"], cleared: 1 });
        await tx.insert(s.runs).values({ ...base, id: "r-3", results: [], cleared: 0 });
      });
    });

    it("cleared > total は拒否", async () => {
      await rolledBack(async (tx) => {
        await expect(
          dbError(tx.insert(s.runs).values({ ...base, results: ["win", "win"], cleared: 3 })),
        ).rejects.toThrow(/check/i);
      });
    });

    it("results が total より長ければ拒否", async () => {
      await rolledBack(async (tx) => {
        await expect(
          dbError(
            tx.insert(s.runs).values({ ...base, results: ["win", "win", "lose"], cleared: 2 }),
          ),
        ).rejects.toThrow(/check/i);
      });
    });

    it("results は win / lose 以外を含めない", async () => {
      await rolledBack(async (tx) => {
        await expect(
          dbError(tx.insert(s.runs).values({ ...base, results: ["draw"], cleared: 0 })),
        ).rejects.toThrow(/check/i);
      });
    });
  });

  describe("R-12.4-3 public / limited な投稿のゲームは verb・input が非 NULL（トリガー）", () => {
    it("verb が NULL のゲームを public にできない", async () => {
      await rolledBack(async (tx) => {
        await seedUser(tx);
        await seedGame(tx, "h-1", { verb: null });
        await seedPost(tx);
        await expect(
          dbError(
            tx.execute(
              sql`update posts set base_status = 'public', showcase_key = 'k' where id = 'p-1'`,
            ),
          ),
        ).rejects.toThrow(/verb|input/);
      });
    });

    it("verb と input が揃っていれば public にできる", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(
          sql`update posts set base_status = 'limited', showcase_key = 'k' where id = 'p-1'`,
        );
      });
    });
  });

  describe("R-12.4-4 run_results ビュー: お題ごとのクリア率・完走率", () => {
    it("クリア率 = Σcleared / Σtotal、完走率 = ended_at 非 NULL の割合", async () => {
      await rolledBack(async (tx) => {
        await seedUser(tx);
        await tx.insert(s.themes).values({
          id: "t-1",
          title: "今日のお題",
          prompt: "x",
          status: "open",
          createdBy: "u-1",
        });
        const started = new Date("2026-11-04T00:00:00Z");
        await tx.insert(s.runs).values([
          {
            id: "r-1",
            themeId: "t-1",
            seed: 1,
            gameIds: ["a"],
            results: ["win", "win", "lose", "win"],
            cleared: 3,
            total: 4,
            startedAt: started,
            endedAt: started,
          },
          {
            id: "r-2",
            themeId: "t-1",
            seed: 1,
            gameIds: ["a"],
            results: ["lose"],
            cleared: 0,
            total: 4,
            startedAt: started,
          },
        ]);
        const r = await tx.execute<{
          theme_id: string;
          runs: string;
          clear_rate: string;
          completion_rate: string;
        }>(
          sql`select theme_id, runs::text, clear_rate::text, completion_rate::text from run_results where theme_id = 't-1'`,
        );
        expect(r).toHaveLength(1);
        expect(Number(r[0]?.runs)).toBe(2);
        expect(Number(r[0]?.clear_rate)).toBeCloseTo(3 / 8, 6);
        expect(Number(r[0]?.completion_rate)).toBeCloseTo(1 / 2, 6);
      });
    });
  });
});
