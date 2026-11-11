/**
 * R-mc.A5-1: 初回のツール呼び出しで `users` 行ができる（mc#A.5、C5）。
 * DB は本物（docs/testing.md）。各テストはトランザクションの中で実行して巻き戻す。
 */

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user as authUser } from "../../src/db/auth-schema.ts";
import { createDb, type Db, migrateDb, resetDb } from "../../src/db/client.ts";
import * as s from "../../src/db/schema.ts";
import { ensureUser } from "../../src/users.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("DATABASE_URL が未設定なので ensureUser の integration テストを skip します");
}
const dbSuite = url ? describe : describe.skip;

dbSuite("R-mc.A5-1 ensureUser（mc#A.5）", () => {
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

  async function addAuthUser(tx: Db, id: string, name: string): Promise<void> {
    await tx.insert(authUser).values({ id, name, email: `${id}@example.test` });
  }

  it("R-mc.A5-1 auth_user だけのユーザーに users 行ができる（trust_score 10、active、handle は slug）", async () => {
    await rolledBack(async (tx) => {
      await addAuthUser(tx, "U0000000000000000000000001", "Taku Sakuma");
      const u = await ensureUser(tx, "U0000000000000000000000001");
      expect(u).toEqual({
        id: "U0000000000000000000000001",
        handle: "taku-sakuma",
        trustScore: 10,
        status: "active",
      });
      const rows = await tx.select().from(s.users);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ handle: "taku-sakuma", trustScore: 10, status: "active" });
    });
  });

  it("R-mc.A5-1 2 回目は何も変えず、既存の行を返す（trust_score・status・handle はそのまま）", async () => {
    await rolledBack(async (tx) => {
      await addAuthUser(tx, "U0000000000000000000000001", "Taku Sakuma");
      await ensureUser(tx, "U0000000000000000000000001");
      await tx
        .update(s.users)
        .set({ trustScore: 55, status: "post_restricted" })
        .where(eq(s.users.id, "U0000000000000000000000001"));
      // 名前が変わっても handle は作り直さない
      await tx
        .update(authUser)
        .set({ name: "Someone Else" })
        .where(eq(authUser.id, "U0000000000000000000000001"));
      const u = await ensureUser(tx, "U0000000000000000000000001");
      expect(u).toEqual({
        id: "U0000000000000000000000001",
        handle: "taku-sakuma",
        trustScore: 55,
        status: "post_restricted",
      });
      const [{ n }] = (await tx.execute(sql`select count(*)::int as n from users`)) as unknown as [
        { n: number },
      ];
      expect(n).toBe(1);
    });
  });

  it("R-mc.A5-1 同名の 2 人目は -2、3 人目は -3", async () => {
    await rolledBack(async (tx) => {
      for (const i of [1, 2, 3]) {
        await addAuthUser(tx, `U000000000000000000000000${i}`, "Taku Sakuma");
      }
      const handles: string[] = [];
      for (const i of [1, 2, 3]) {
        handles.push((await ensureUser(tx, `U000000000000000000000000${i}`)).handle);
      }
      expect(handles).toEqual(["taku-sakuma", "taku-sakuma-2", "taku-sakuma-3"]);
    });
  });

  it("R-mc.A5-1 非ラテン・3 文字未満の名前は user-<id 末尾 6 文字（小文字）>", async () => {
    await rolledBack(async (tx) => {
      await addAuthUser(tx, "U00000000000000000000ABCDEF", "佐久間");
      await addAuthUser(tx, "U00000000000000000000UVWXYZ", "a");
      expect((await ensureUser(tx, "U00000000000000000000ABCDEF")).handle).toBe("user-abcdef");
      expect((await ensureUser(tx, "U00000000000000000000UVWXYZ")).handle).toBe("user-uvwxyz");
    });
  });

  it("R-mc.A5-1 既に他人が使っている handle（-2 も）は飛ばす", async () => {
    await rolledBack(async (tx) => {
      await tx.insert(s.users).values([
        { id: "X1", handle: "taku-sakuma" },
        { id: "X2", handle: "taku-sakuma-2" },
      ]);
      await addAuthUser(tx, "U0000000000000000000000009", "Taku Sakuma");
      expect((await ensureUser(tx, "U0000000000000000000000009")).handle).toBe("taku-sakuma-3");
    });
  });

  it("R-mc.A5-1 auth_user にいない id は行を作らず失敗する", async () => {
    await rolledBack(async (tx) => {
      await expect(ensureUser(tx, "NOBODY")).rejects.toThrow(/auth_user/);
      expect(await tx.select().from(s.users)).toHaveLength(0);
    });
  });
});
