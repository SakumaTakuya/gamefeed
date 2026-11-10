/**
 * データモデル（docs/data-model.md）の integration テスト。
 *
 * 空の Postgres にマイグレーションを当て、DB 制約（CHECK / UNIQUE / FK / トリガー / ビュー）が
 * 仕様どおりに効くことを確かめる。DB は本物（docs/testing.md）。CI は Postgres service container、
 * ローカルは DATABASE_URL を指す Postgres。
 *
 * 各テストはトランザクションの中で実行して最後に巻き戻す（docs/testing.md 4. integration）。
 */

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

dbSuite("data-model.md データモデル", () => {
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
   * 拒否されるべきクエリをセーブポイントの中で実行し、メッセージを検査する。
   * Postgres は 1 文失敗するとトランザクション全体が abort するので、1 テスト内で複数の拒否を試すにはこれが要る。
   */
  async function rejects(tx: Db, fn: (t: Db) => Promise<unknown>, re: RegExp): Promise<void> {
    let err: unknown;
    try {
      await tx.transaction(async (sp) => {
        await fn(sp as unknown as Db);
      });
    } catch (e) {
      err = e;
    }
    if (err === undefined) throw new Error("DB が拒否するはずのクエリが通った");
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(re);
  }

  // ---- fixtures ---------------------------------------------------------------

  async function seedUser(tx: Db, id = "u-1", handle = "alice") {
    await tx.insert(s.users).values({ id, handle });
    return id;
  }
  /** 遊ぶ側の主体。userId を渡すとログイン済み（通報の重みが残る）。 */
  async function seedActor(tx: Db, id = "a-1", userId: string | null = null) {
    await tx.insert(s.actors).values({ id, deviceId: `dev-${id}`, userId });
    return id;
  }
  const fullMeta = {
    title: "押せ！",
    verb: "押せ！",
    input: "tap",
    duration_frames: 300,
    target: 12,
    deterministic: true,
    warnings: [],
  };
  async function seedGame(tx: Db, hash = "h-1", meta: Record<string, unknown> = fullMeta) {
    await tx.insert(s.games).values({ hash, size: 1024, r2Key: `games/${hash}.html`, meta });
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
  /** draft の投稿を limited / public にする（published_at を入れる。I4） */
  async function publish(tx: Db, id: string, status: "limited" | "public" = "public") {
    await tx.execute(
      sql`update posts set base_status = ${status}::base_status, published_at = now() where id = ${id}`,
    );
  }
  async function seedRun(tx: Db, id = "r-1", extra: Partial<typeof s.runs.$inferInsert> = {}) {
    await tx.insert(s.runs).values({
      id,
      mode: "endless",
      actorId: "a-1",
      deck: Array.from({ length: 12 }, () => "p-1"),
      newIndex: 11,
      lives: 3,
      ...extra,
    });
    return id;
  }
  function session(
    extra: Partial<typeof s.sessions.$inferInsert> = {},
  ): typeof s.sessions.$inferInsert {
    return {
      id: "s-1",
      postId: "p-1",
      gameHash: "h-1",
      actorId: "a-1",
      deviceKind: "ios",
      mode: "play",
      seed: 2891734521,
      speed: "1.000",
      timeLimit: 300,
      ...extra,
    };
  }
  async function seedAll(tx: Db) {
    await seedUser(tx);
    await seedActor(tx);
    await seedGame(tx);
    await seedPost(tx);
  }
  async function statusOf(tx: Db, id: string): Promise<string | undefined> {
    const r = await tx.execute<{ status: string }>(
      sql`select status from post_status where id = ${id}`,
    );
    return r[0]?.status;
  }
  async function eligibilityOf(tx: Db, id: string): Promise<string | undefined> {
    const r = await tx.execute<{ eligibility: string }>(
      sql`select eligibility from post_eligibility where id = ${id}`,
    );
    return r[0]?.eligibility;
  }

  // ---- R-12.1 テーブル ---------------------------------------------------------

  describe("R-12.1-1 全テーブルと列挙型がマイグレーションで作られる", () => {
    it("dm#A.3 の 13 テーブルと Phase 2 の 3 表が存在し、旧 12.4 のビュー run_results は無い", async () => {
      const r = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      );
      const names = r.map((x) => x.table_name);
      for (const t of [
        "users",
        "actors",
        "themes",
        "theme_posts",
        "games",
        "posts",
        "sessions",
        "runs",
        "likes",
        "reports",
        "moderation_actions",
        "tree_locks",
        "post_stats",
        "fork_tokens",
        "assets",
        "post_assets",
      ]) {
        expect(names, `テーブル ${t}`).toContain(t);
      }
      const v = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.views where table_schema = 'public'`,
      );
      const views = v.map((x) => x.table_name);
      expect(views).toContain("post_status");
      expect(views).toContain("post_eligibility");
      expect(views).not.toContain("run_results");
    });

    it("列挙型は dm#A.2 の値を記載順に持つ", async () => {
      const r = await db.execute<{ typname: string; labels: string[] }>(
        sql`select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
            from pg_type t join pg_enum e on e.enumtypid = t.oid
            group by t.typname`,
      );
      const enums = Object.fromEntries(r.map((x) => [x.typname, x.labels]));
      expect(enums.user_status).toEqual(["active", "post_restricted", "banned"]);
      expect(enums.base_status).toEqual(["draft", "limited", "public", "unpublished", "removed"]);
      expect(enums.calibration).toEqual(["uncalibrated", "calibrated", "review", "invalid"]);
      expect(enums.session_state).toEqual(["open", "submitted", "skipped", "abandoned"]);
      expect(enums.session_mode).toEqual(["play", "replay"]);
      expect(enums.session_via).toEqual(["guest", "timeout", "error"]);
      expect(enums.verdict).toEqual(["provisional", "accepted", "rejected", "flagged"]);
      expect(enums.run_mode).toEqual(["endless", "daily"]);
      expect(enums.run_end).toEqual(["lives", "limit", "abandoned"]);
      expect(enums.report_resolution).toEqual(["open", "upheld", "dismissed"]);
      expect(enums.moderation_kind).toEqual([
        "restrict",
        "restore",
        "remove",
        "restrict_tree",
        "restore_tree",
        "ban_user",
        "unban_user",
        "calibration_confirm",
        "calibration_invalidate",
      ]);
      expect(enums.device_kind).toEqual(["ios", "android", "other"]);
      expect(enums.asset_type).toEqual(["image", "sfx", "model", "font"]);
      expect(enums.asset_source).toEqual(["library", "user"]);
      expect(enums.theme_status).toBeUndefined();
    });

    it("廃止した列は無い（dm#A.7）", async () => {
      const r = await db.execute<{ table_name: string; column_name: string }>(
        sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
      );
      const cols = new Set(r.map((x) => `${x.table_name}.${x.column_name}`));
      for (const c of [
        "games.theme_id",
        "games.verb",
        "games.input",
        "games.duration_frames",
        "games.thumb_key",
        "posts.controls",
        "posts.showcase_key",
        "posts.deterministic",
        "sessions.checkpoint",
        "sessions.opened_at",
        "sessions.user_id",
        "runs.seed",
        "runs.game_ids",
        "runs.results",
        "runs.cleared",
        "runs.total",
        "runs.user_id",
        "reports.reporter_id",
        "moderation_actions.actor_id",
      ]) {
        expect(cols.has(c), `列 ${c}`).toBe(false);
      }
      for (const c of [
        "games.meta",
        "games.stored_at",
        "posts.published_at",
        "sessions.actor_id",
      ]) {
        expect(cols.has(c), `列 ${c}`).toBe(true);
      }
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
        await rejects(tx, (t) => seedUser(t, "u-2", "alice"), /unique/i);
      });
    });

    it("actors.device_id は一意（I17）", async () => {
      await rolledBack(async (tx) => {
        await tx.insert(s.actors).values({ id: "a-1", deviceId: "dev" });
        await rejects(
          tx,
          (t) => t.insert(s.actors).values({ id: "a-2", deviceId: "dev" }),
          /unique/i,
        );
      });
    });

    it("reports は (post_id, actor_id) で一意（I14）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedActor(tx, "a-2", "u-1");
        const row = { postId: "p-1", actorId: "a-2", category: "spam", weight: 1 };
        await tx.insert(s.reports).values(row);
        await rejects(tx, (t) => t.insert(s.reports).values(row), /unique/i);
      });
    });

    it("likes は (post_id, actor_id) で一意（I14）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.likes).values({ postId: "p-1", actorId: "a-1" });
        await rejects(
          tx,
          (t) => t.insert(s.likes).values({ postId: "p-1", actorId: "a-1" }),
          /unique|duplicate/i,
        );
      });
    });

    it("sessions は (run_id, turn) で一意（I13）。試遊（run_id NULL）は制約を受けない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedRun(tx);
        await tx.insert(s.sessions).values(session({ id: "s-1", runId: "r-1", turn: 0 }));
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-2", runId: "r-1", turn: 0 })),
          /unique/i,
        );
        await tx.insert(s.sessions).values(session({ id: "s-3" }));
        await tx.insert(s.sessions).values(session({ id: "s-4" }));
      });
    });

    it("theme_posts は (theme_id, post_id) と (theme_id, position) で一意、position は 0〜9", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedPost(tx, "p-2");
        await tx.insert(s.themes).values({ id: "t-1", slug: "ten-seconds", title: "10 秒" });
        await tx.insert(s.themePosts).values({ themeId: "t-1", position: 0, postId: "p-1" });
        await rejects(
          tx,
          (t) => t.insert(s.themePosts).values({ themeId: "t-1", position: 1, postId: "p-1" }),
          /unique/i,
        );
        await rejects(
          tx,
          (t) => t.insert(s.themePosts).values({ themeId: "t-1", position: 0, postId: "p-2" }),
          /unique|duplicate/i,
        );
        await rejects(
          tx,
          (t) => t.insert(s.themePosts).values({ themeId: "t-1", position: 10, postId: "p-2" }),
          /theme_posts_position_range/,
        );
      });
    });

    it("post_assets は (post_id, name) で一意", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.assets).values({
          hash: "a-1",
          type: "image",
          size: 100,
          r2Key: "assets/a-1.webp",
          source: "library",
          scan: {},
        });
        const row = { postId: "p-1", name: "hero.webp", assetHash: "a-1", required: false };
        await tx.insert(s.postAssets).values(row);
        await rejects(tx, (t) => t.insert(s.postAssets).values(row), /unique|duplicate/i);
      });
    });
  });

  describe("R-12.1-3 posts.parent_id は posts.id への外部キーで、削除は RESTRICT", () => {
    it("子がある投稿は削除できない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedPost(tx, "p-2", { parentId: "p-1", treeId: "p-1", depth: 1 });
        await rejects(
          tx,
          (t) => t.execute(sql`delete from posts where id = 'p-1'`),
          /foreign key|violates/i,
        );
      });
    });

    it("存在しない親は指せない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await rejects(
          tx,
          (t) => seedPost(t, "p-2", { parentId: "nope", treeId: "nope", depth: 1 }),
          /foreign key|violates/i,
        );
      });
    });

    it("draft の削除で試遊セッションはカスケードで消える（I11、mo#B.6）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.sessions).values(session({ id: "s-1" }));
        await tx.execute(sql`delete from posts where id = 'p-1'`);
        const r = await tx.execute<{ n: string }>(sql`select count(*)::text as n from sessions`);
        expect(Number(r[0]?.n)).toBe(0);
      });
    });
  });

  describe("R-12.1-4 sessions の CHECK（dm#A.3、I12）", () => {
    it("open のセッションは submitted_at / via / score / frames が NULL で入る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.sessions).values(session());
      });
    });

    it("submitted には submitted_at と via が要る。open にはどちらも無い", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        const sub = session({ state: "submitted", score: 10, frames: 300 });
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values({ ...sub, via: "guest" }),
          /sessions_submitted_at_iff_submitted/,
        );
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values({ ...sub, submittedAt: new Date() }),
          /sessions_via_iff_submitted/,
        );
        await tx.insert(s.sessions).values({ ...sub, via: "guest", submittedAt: new Date() });
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-2", submittedAt: new Date() })),
          /sessions_submitted_at_iff_submitted/,
        );
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-3", via: "timeout" })),
          /sessions_via_iff_submitted/,
        );
      });
    });

    it("score は 0 以上（gc#A.4）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.sessions).values(session({ id: "s-0", score: 0 }));
        await tx.insert(s.sessions).values(session({ id: "s-max", score: 2 ** 31 - 1 }));
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-neg", score: -1 })),
          /sessions_score_nonnegative/,
        );
      });
    });

    it("frames は 1〜time_limit（sc#A.2）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.sessions).values(session({ id: "s-1", frames: 1 }));
        await tx.insert(s.sessions).values(session({ id: "s-2", frames: 300 }));
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-3", frames: 0 })),
          /sessions_frames_range/,
        );
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-4", frames: 301 })),
          /sessions_frames_range/,
        );
      });
    });

    it("speed は 1.000 / 1.125 / 1.250 / 1.375 / 1.500 のどれか（run#A.8）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        for (const [i, sp] of ["1.000", "1.125", "1.250", "1.375", "1.500"].entries()) {
          await tx.insert(s.sessions).values(session({ id: `s-${i}`, speed: sp }));
        }
        for (const sp of ["0.999", "1.100", "1.501", "2.000"]) {
          await rejects(
            tx,
            (t) => t.insert(s.sessions).values(session({ id: `s-${sp}`, speed: sp })),
            /sessions_speed_values/,
          );
        }
      });
    });

    it("miss_below が非 NULL なら run_id が非 NULL、is_new = false、ランは endless", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedRun(tx, "r-e");
        await tx.insert(s.themes).values({ id: "t-1", slug: "x", title: "x" });
        await seedRun(tx, "r-d", {
          mode: "daily",
          themeId: "t-1",
          date: "2026-11-10",
          deck: Array.from({ length: 10 }, () => "p-1"),
          newIndex: 0,
          lives: 0,
        });
        await tx
          .insert(s.sessions)
          .values(session({ id: "s-ok", runId: "r-e", turn: 0, missBelow: 40 }));
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-1", missBelow: 40 })),
          /sessions_miss_below_requires_run/,
        );
        await rejects(
          tx,
          (t) =>
            tx
              .insert(s.sessions)
              .values(session({ id: "s-2", runId: "r-e", turn: 1, isNew: true, missBelow: 40 })),
          /sessions_miss_below_requires_run/,
        );
        await rejects(
          tx,
          (t) =>
            tx
              .insert(s.sessions)
              .values(session({ id: "s-3", runId: "r-d", turn: 0, missBelow: 40 })),
          /endless/,
        );
        await tx.insert(s.sessions).values(session({ id: "s-4", runId: "r-d", turn: 0 }));
      });
    });

    it("runs.mode は作成後に変えられない（endless のまま miss_below の前提を守る）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedRun(tx);
        await tx.insert(s.themes).values({ id: "t-1", slug: "x", title: "x" });
        await rejects(
          tx,
          (t) =>
            t.execute(
              sql`update runs set mode = 'daily', theme_id = 't-1', date = '2026-11-10', new_index = 0 where id = 'r-1'`,
            ),
          /runs.mode/,
        );
      });
    });

    it("turn は run_id と同時にだけ入る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedRun(tx);
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-1", turn: 0 })),
          /sessions_turn_iff_run/,
        );
        await rejects(
          tx,
          (t) => t.insert(s.sessions).values(session({ id: "s-2", runId: "r-1" })),
          /sessions_turn_iff_run/,
        );
      });
    });
  });

  describe("R-12.1-5 表示用 status は base_status・indiv_restricted・tree_locks から導出するビュー", () => {
    it("public で制限なしなら public", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await publish(tx, "p-1");
        expect(await statusOf(tx, "p-1")).toBe("public");
      });
    });

    it("indiv_restricted なら restricted", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await publish(tx, "p-1");
        await tx.execute(sql`update posts set indiv_restricted = true where id = 'p-1'`);
        expect(await statusOf(tx, "p-1")).toBe("restricted");
      });
    });

    it("祖先が tree_locks にあれば子孫も restricted、根の制限を外せば戻る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedPost(tx, "p-2", { parentId: "p-1", treeId: "p-1", depth: 1 });
        await seedPost(tx, "p-3", { parentId: "p-2", treeId: "p-1", depth: 2 });
        for (const id of ["p-1", "p-2", "p-3"]) await publish(tx, id);
        await tx.insert(s.moderationActions).values({
          id: 1,
          moderatorId: "u-1",
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

    it("draft / unpublished / removed は制限の有無にかかわらずそのまま", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(sql`update posts set indiv_restricted = true where id = 'p-1'`);
        expect(await statusOf(tx, "p-1")).toBe("draft");
        await publish(tx, "p-1");
        await tx.execute(sql`update posts set base_status = 'unpublished' where id = 'p-1'`);
        expect(await statusOf(tx, "p-1")).toBe("unpublished");
        await tx.execute(sql`update posts set base_status = 'removed' where id = 'p-1'`);
        expect(await statusOf(tx, "p-1")).toBe("removed");
      });
    });

    it("post_eligibility: public かつ calibrated は normal、limited/public かつ uncalibrated かつ thumb_key ありは new、他は none", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        expect(await eligibilityOf(tx, "p-1")).toBe("none"); // draft
        await publish(tx, "p-1", "limited");
        expect(await eligibilityOf(tx, "p-1")).toBe("none"); // サムネ待ち（mc#A.9）
        await tx.execute(sql`update posts set thumb_key = 'thumbs/p-1.webp' where id = 'p-1'`);
        expect(await eligibilityOf(tx, "p-1")).toBe("new");
        await tx.execute(sql`update posts set calibration = 'calibrated' where id = 'p-1'`);
        expect(await eligibilityOf(tx, "p-1")).toBe("none"); // limited のまま calibrated は出ない
        await tx.execute(sql`update posts set base_status = 'public' where id = 'p-1'`);
        expect(await eligibilityOf(tx, "p-1")).toBe("normal");
        await tx.execute(sql`update posts set indiv_restricted = true where id = 'p-1'`);
        expect(await eligibilityOf(tx, "p-1")).toBe("none"); // restricted
      });
    });
  });

  // ---- dm#A.5 不変条件 -----------------------------------------------------------

  describe("R-12.2-1 I1: parent_id は更新不可（トリガー）", () => {
    it("NULL → 値、値 → 別の値、値 → NULL のいずれも拒否", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedPost(tx, "p-2");
        await seedPost(tx, "p-3", { parentId: "p-1", treeId: "p-1", depth: 1 });
        await rejects(
          tx,
          (t) => t.execute(sql`update posts set parent_id = 'p-2' where id = 'p-1'`),
          /parent_id/,
        );
        await rejects(
          tx,
          (t) => t.execute(sql`update posts set parent_id = 'p-2' where id = 'p-3'`),
          /parent_id/,
        );
        await rejects(
          tx,
          (t) => t.execute(sql`update posts set parent_id = null where id = 'p-3'`),
          /parent_id/,
        );
      });
    });

    it("parent_id 以外の更新は通る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.execute(sql`update posts set title = 'x' where id = 'p-1'`);
      });
    });
  });

  describe("R-12.2-4 I4: limited / public / unpublished なら published_at が非 NULL（CHECK）", () => {
    it("published_at なしで公開はできない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        for (const st of ["limited", "public"]) {
          await rejects(
            tx,
            (t) =>
              t.execute(sql`update posts set base_status = ${st}::base_status where id = 'p-1'`),
            /posts_published_at_when_published/,
          );
        }
      });
    });

    it("draft なら published_at は NULL でよく、thumb_key は後から入る（mc#A.9）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await publish(tx, "p-1", "limited");
        await tx.execute(sql`update posts set thumb_key = 'thumbs/p-1.webp' where id = 'p-1'`);
      });
    });
  });

  describe("R-12.2-5 I5: base_status の遷移表（トリガー。mo#A.2）", () => {
    const set = (tx: Db, st: string) =>
      tx.execute(sql`update posts set base_status = ${st}::base_status where id = 'p-1'`);

    it("removed から出る遷移はない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await publish(tx, "p-1");
        await set(tx, "removed");
        for (const st of ["draft", "limited", "public", "unpublished"]) {
          await rejects(tx, (t) => set(t, st), /I5/);
        }
        await tx.execute(sql`update posts set indiv_restricted = true where id = 'p-1'`);
      });
    });

    it("unpublished からは limited / public / removed にだけ行ける。draft には戻れない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await publish(tx, "p-1");
        await set(tx, "unpublished");
        await rejects(tx, (t) => set(t, "draft"), /I5/);
        await set(tx, "limited");
        await set(tx, "unpublished");
        await set(tx, "public");
        await set(tx, "unpublished");
        await set(tx, "removed");
      });
    });

    it("limited → public、public → limited は不可、draft → unpublished / removed は不可", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await rejects(tx, (t) => set(t, "unpublished"), /I5/);
        await rejects(tx, (t) => set(t, "removed"), /I5/);
        await publish(tx, "p-1", "limited");
        await set(tx, "public");
        await rejects(tx, (t) => set(t, "limited"), /I5/);
      });
    });
  });

  describe("R-12.2-3 I3: tree_locks の action_id は moderation_actions を指す（FK）", () => {
    it("監査行のない tree_lock は入らない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await rejects(
          tx,
          (t) => t.insert(s.treeLocks).values({ rootPostId: "p-1", actionId: 999 }),
          /foreign key|violates/i,
        );
      });
    });

    it("自動制限の監査行は moderator_id = NULL で入る（mo#A.4）。restrict は post_id か user_id のどちらか一方", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.moderationActions).values({
          kind: "restrict",
          postId: "p-1",
          reason: "auto",
        });
        await rejects(
          tx,
          (t) =>
            tx
              .insert(s.moderationActions)
              .values({ kind: "restrict", postId: "p-1", userId: "u-1", reason: "x" }),
          /moderation_actions_restrict_target/,
        );
        await rejects(
          tx,
          (t) => t.insert(s.moderationActions).values({ kind: "restore", reason: "x" }),
          /moderation_actions_restrict_target/,
        );
      });
    });
  });

  describe("R-dm.A5-10 I10: game_hash / title / prompt は draft の間だけ更新できる（トリガー）", () => {
    it("draft では内容を置き換えられる", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedGame(tx, "h-2");
        await tx.execute(
          sql`update posts set game_hash = 'h-2', title = 't2', prompt = 'p2' where id = 'p-1'`,
        );
      });
    });

    it("公開後は game_hash / title / prompt のどれも変えられない。他の列は変えられる", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedGame(tx, "h-2");
        await publish(tx, "p-1");
        for (const col of ["game_hash = 'h-2'", "title = 'x'", "prompt = 'x'"]) {
          await rejects(
            tx,
            (t) => t.execute(sql.raw(`update posts set ${col} where id = 'p-1'`)),
            /I10/,
          );
        }
        await tx.execute(
          sql`update posts set thumb_key = 'k', updated_at = now() where id = 'p-1'`,
        );
        await tx.execute(sql`update posts set base_status = 'unpublished' where id = 'p-1'`);
        await rejects(
          tx,
          (t) => t.execute(sql`update posts set title = 'x' where id = 'p-1'`),
          /I10/,
        );
      });
    });
  });

  describe("R-dm.A5-13 I13: ended_at の後は凍結値を変えられない（トリガー）", () => {
    it("終了前は書けるが、終了後は reached / avg_deviation / symbols / ended を変えられない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedRun(tx);
        await tx.execute(sql`update runs set reached = 5 where id = 'r-1'`);
        await tx.execute(
          sql`update runs set reached = 7, avg_deviation = 52.3, ended = 'lives', ended_at = now() where id = 'r-1'`,
        );
        for (const col of [
          "reached = 8",
          "avg_deviation = 50.0",
          "symbols = 'x'",
          "ended = 'limit'",
          "ended_at = now() + interval '1 second'",
        ]) {
          await rejects(
            tx,
            (t) => t.execute(sql.raw(`update runs set ${col} where id = 'r-1'`)),
            /I13/,
          );
        }
      });
    });

    it("ended と ended_at は同時にだけ入る", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedRun(tx);
        await rejects(
          tx,
          (t) => t.execute(sql`update runs set ended = 'lives' where id = 'r-1'`),
          /runs_ended_iff_ended_at/,
        );
      });
    });
  });

  describe("R-dm.A5-16 I16: 同じ主体・お題・日付で recorded = true のランは 1 本（部分一意索引）", () => {
    it("2 本目の recorded は入らない。recorded = false なら何本でも", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await tx.insert(s.themes).values({ id: "t-1", slug: "x", title: "x" });
        const daily = (id: string, recorded: boolean) =>
          seedRun(tx, id, {
            mode: "daily",
            themeId: "t-1",
            date: "2026-11-10",
            deck: Array.from({ length: 10 }, () => "p-1"),
            newIndex: 0,
            lives: 0,
            recorded,
          });
        await daily("r-1", true);
        await rejects(tx, (t) => daily("r-2", true), /runs_recorded_unique/);
        await daily("r-3", false);
        await daily("r-4", false);
      });
    });

    it("デイリーは theme_id と date を持ち、エンドレスは持たない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await rejects(tx, (t) => seedRun(t, "r-1", { mode: "daily" }), /runs_daily_fields/);
        await tx.insert(s.themes).values({ id: "t-1", slug: "x", title: "x" });
        await rejects(
          tx,
          (t) => seedRun(t, "r-2", { mode: "endless", themeId: "t-1", date: "2026-11-10" }),
          /runs_daily_fields/,
        );
      });
    });
  });

  describe("R-dm.A5-17 I17: actors.user_id は一度埋まったら変えられない（トリガー）", () => {
    it("NULL → 値は通り、値 → 別の値、値 → NULL は拒否", async () => {
      await rolledBack(async (tx) => {
        await seedUser(tx, "u-1", "alice");
        await seedUser(tx, "u-2", "bob");
        await seedActor(tx, "a-1");
        await tx.execute(sql`update actors set user_id = 'u-1' where id = 'a-1'`);
        await rejects(
          tx,
          (t) => t.execute(sql`update actors set user_id = 'u-2' where id = 'a-1'`),
          /I17/,
        );
        await rejects(
          tx,
          (t) => t.execute(sql`update actors set user_id = null where id = 'a-1'`),
          /I17/,
        );
        // 同じ値での更新は通る
        await tx.execute(sql`update actors set user_id = 'u-1' where id = 'a-1'`);
      });
    });
  });

  describe("R-dm.A5-14 I14: 匿名の主体の通報は weight = 0（トリガー）", () => {
    it("actors.user_id が NULL なら weight は 0 に書き換わり、ログイン済みならそのまま", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedActor(tx, "a-2", "u-1");
        await tx.insert(s.reports).values([
          { postId: "p-1", actorId: "a-1", category: "sexual", weight: 3 },
          { postId: "p-1", actorId: "a-2", category: "sexual", weight: 3 },
        ]);
        const r = await tx.execute<{ actor_id: string; weight: number }>(
          sql`select actor_id, weight from reports order by actor_id`,
        );
        expect(r.map((x) => [x.actor_id, Number(x.weight)])).toEqual([
          ["a-1", 0],
          ["a-2", 3],
        ]);
      });
    });
  });

  describe("R-12.4-3 limited / public にする投稿の games.meta は verb / input / duration_frames / target を持つ（トリガー）", () => {
    it("meta が欠けたゲームの投稿は公開できない", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedGame(tx, "h-partial", { title: "x", verb: "押せ！", input: "tap" });
        await seedPost(tx, "p-2", { gameHash: "h-partial" });
        await rejects(tx, (t) => publish(t, "p-2"), /games.meta/);
        await rejects(tx, (t) => publish(t, "p-2", "limited"), /games.meta/);
      });
    });

    it("meta が揃っていれば公開できる。draft の間は欠けていてよい", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await seedGame(tx, "h-partial", {});
        await seedPost(tx, "p-2", { gameHash: "h-partial" });
        await publish(tx, "p-1");
      });
    });

    it("games.size は 128 KiB 以下、post_stats.n は scores の長さと一致（CHECK）", async () => {
      await rolledBack(async (tx) => {
        await seedAll(tx);
        await rejects(
          tx,
          (t) => t.insert(s.games).values({ hash: "big", size: 131073, r2Key: "x", meta: {} }),
          /games_size_max/,
        );
        await tx.insert(s.postStats).values({ postId: "p-1", n: 2, scores: [3, 10] });
        await rejects(
          tx,
          (t) => t.insert(s.postStats).values({ postId: "p-1", n: 1, scores: [3, 10] }),
          /post_stats_n_matches_scores|unique|duplicate/,
        );
      });
    });
  });
});
