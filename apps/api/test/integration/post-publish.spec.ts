/**
 * 公開直後のジョブ（mc#A.9、sc#A.10。R-mc.A9-1）の integration テスト。Postgres は本物、ハーネスは fake。
 * ハーネス（headless Chromium）が返す結果を、投稿にどう反映するかを見る。
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.ts";
import { MANUAL_THUMB_KEY } from "../../src/manual-thumb.ts";
import {
  applyCheck,
  type HarnessRun,
  judge,
  pendingPosts,
  thumbKeyOf,
} from "../../src/post-publish.ts";
import { useRunHarness } from "../helpers/run-harness.ts";

const url = process.env.DATABASE_URL;
if (!url)
  console.warn("DATABASE_URL が未設定なので post-publish の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

const ended = (speed: number): HarnessRun => ({
  speed,
  gameStatus: 200,
  report: { phase: "done", outcome: "ended", score: 3, frames: 180 },
});
const WEBP = new Uint8Array([82, 73, 70, 70]);

describe("R-mc.A9-1 judge（ハーネスの結果の扱い。sc#A.10 の表）", () => {
  it("両方の速度で end が届けば ok", () => {
    expect(judge([ended(1), ended(1.5)])).toEqual({ kind: "ok" });
  });

  it("GF.end() を呼ばず制限時間で終わるゲーム（frames が time_limit の end）も ok", () => {
    const full: HarnessRun = {
      ...ended(1),
      report: { phase: "done", outcome: "ended", score: 0, frames: 600 },
    };
    expect(judge([full, ended(1.5)])).toEqual({ kind: "ok" });
  });

  it.each(["timeout", "error", "navigated", "violation"] as const)(
    "%s は broken（どちらかの速度だけでも）",
    (outcome) => {
      const bad: HarnessRun = {
        speed: 1.5,
        gameStatus: 200,
        report: { phase: "done", outcome, detail: "x" },
      };
      expect(judge([ended(1), bad])).toMatchObject({ kind: "broken" });
    },
  );

  it("配信された（200）のに ready が来なければ broken。配信されていなければ retry（KV の反映待ち）", () => {
    const noReady = (gameStatus: number | null): HarnessRun => ({
      speed: 1,
      gameStatus,
      report: { phase: "done", outcome: "no_ready", detail: null },
    });
    expect(judge([noReady(200)])).toMatchObject({ kind: "broken" });
    expect(judge([noReady(404)])).toMatchObject({ kind: "retry" });
    expect(judge([noReady(null)])).toMatchObject({ kind: "retry" });
  });

  it("ゲームが配信された後に応答が止まった（固まったゲームが Host ごと止めた）は broken", () => {
    for (const report of [{ phase: "running" }, { phase: "loading" }, null] as const) {
      expect(judge([{ speed: 1, gameStatus: 200, report }])).toMatchObject({ kind: "broken" });
    }
  });

  it("ページが開けない・ゲームが配信されないまま終わらないは retry。1 回も走っていなくても retry", () => {
    expect(judge([{ speed: 1, gameStatus: null, report: null }])).toMatchObject({ kind: "retry" });
    expect(judge([{ speed: 1, gameStatus: 404, report: { phase: "loading" } }])).toMatchObject({
      kind: "retry",
    });
    expect(judge([])).toMatchObject({ kind: "retry" });
    // 片方しか走っていなければ決めない
    expect(judge([ended(1)])).toMatchObject({ kind: "retry" });
  });
});

dbSuite("R-mc.A9-1 公開直後のジョブ（対象の拾い方と結果の反映）", () => {
  const h = useRunHarness(url as string);
  const A = "01M782MV00TMYMTHTGG5C6KS3A";
  const B = "01M782MV00TMYMTHTGG5C6KS3B";
  const C = "01M782MV00TMYMTHTGG5C6KS3C";
  const D = "01M782MV00TMYMTHTGG5C6KS3D";
  const E = "01M782MV00TMYMTHTGG5C6KS3E";

  async function seed(
    id: string,
    o: {
      status?: "draft" | "limited" | "public";
      calibration?: "uncalibrated" | "calibrated" | "invalid";
      thumbKey?: string;
    } = {},
  ): Promise<string> {
    await h.db.insert(s.posts).values({
      id,
      userId: "author",
      gameHash: "h-1",
      title: id,
      prompt: "",
      treeId: id,
      depth: 0,
      calibration: o.calibration ?? "uncalibrated",
      thumbKey: o.thumbKey ?? null,
    });
    const status = o.status ?? "limited";
    if (status !== "draft") {
      await h.db.execute(
        sql`update posts set base_status = ${status}::base_status, published_at = now() where id = ${id}`,
      );
    }
    return id;
  }
  const rowOf = async (id: string) => {
    const [row] = await h.db.execute<{ thumb_key: string | null; calibration: string; e: string }>(
      sql`select p.thumb_key, p.calibration, pe.eligibility as e
          from posts p join post_eligibility pe on pe.id = p.id where p.id = ${id}`,
    );
    return row;
  };
  function storage() {
    const puts = new Map<string, Uint8Array>();
    return { puts, putThumb: async (key: string, webp: Uint8Array) => void puts.set(key, webp) };
  }

  it("拾うのは、公開中・未校正・thumb_key が NULL の投稿だけ。公開の古い順", async () => {
    await seed(A, { status: "public" });
    await seed(B, { status: "limited" });
    await seed(C, { status: "draft" });
    await seed(D, { calibration: "invalid" });
    await seed(E, { thumbKey: MANUAL_THUMB_KEY });
    await h.db.execute(
      sql`update posts set published_at = now() - interval '1 hour' where id = ${B}`,
    );
    expect((await pendingPosts(h.db, { redoManual: false })).map((p) => p.id)).toEqual([B, A]);
  });

  it("R2 の鍵があるときは、目印 manual の投稿（校正済みも）も拾って画像を作り直す", async () => {
    await seed(A);
    await seed(B, { thumbKey: MANUAL_THUMB_KEY, calibration: "calibrated", status: "public" });
    await seed(C, { thumbKey: thumbKeyOf(C) });
    await seed(D, { thumbKey: MANUAL_THUMB_KEY, calibration: "invalid" });
    const got = await pendingPosts(h.db, { redoManual: true });
    expect(got.map((p) => p.id).sort()).toEqual([A, B]);
  });

  it("ok: サムネを thumbs/<post_id>.webp に保存して thumb_key を入れる。新作枠（new）に入る", async () => {
    await seed(A);
    const st = storage();
    expect(await applyCheck(h.db, A, { kind: "ok" }, { thumb: WEBP, storage: st })).toBe("thumb");
    expect(st.puts.get(`thumbs/${A}.webp`)).toEqual(WEBP);
    expect(await rowOf(A)).toMatchObject({ thumb_key: `thumbs/${A}.webp`, e: "new" });
  });

  it("ok でも R2 の鍵が無い（または画像が撮れなかった）なら、目印 manual を入れる。ランには出る", async () => {
    await seed(A);
    expect(await applyCheck(h.db, A, { kind: "ok" }, { thumb: WEBP, storage: null })).toBe(
      "manual",
    );
    expect(await rowOf(A)).toMatchObject({ thumb_key: MANUAL_THUMB_KEY, e: "new" });
    await seed(B);
    expect(await applyCheck(h.db, B, { kind: "ok" }, { thumb: null, storage: storage() })).toBe(
      "manual",
    );
  });

  it("ok: 目印 manual は本物のキーに置き換える。もう本物が入っていれば変えない", async () => {
    await seed(A, { thumbKey: MANUAL_THUMB_KEY });
    const st = storage();
    expect(await applyCheck(h.db, A, { kind: "ok" }, { thumb: WEBP, storage: st })).toBe("thumb");
    expect((await rowOf(A))?.thumb_key).toBe(`thumbs/${A}.webp`);
    // 鍵が無い回が後から来ても、目印に戻さない
    expect(await applyCheck(h.db, A, { kind: "ok" }, { thumb: WEBP, storage: null })).toBe("none");
    expect((await rowOf(A))?.thumb_key).toBe(`thumbs/${A}.webp`);
  });

  it("broken: thumb_key を入れず calibration = invalid。ランに出ない（none）", async () => {
    await seed(A);
    expect(
      await applyCheck(
        h.db,
        A,
        { kind: "broken", reason: "timeout" },
        { thumb: null, storage: null },
      ),
    ).toBe("invalid");
    expect(await rowOf(A)).toEqual({ thumb_key: null, calibration: "invalid", e: "none" });
  });

  it("broken でも、invalid にするのは uncalibrated だけ（校正済みは変えない）", async () => {
    await seed(A, { thumbKey: MANUAL_THUMB_KEY, calibration: "calibrated", status: "public" });
    expect(
      await applyCheck(
        h.db,
        A,
        { kind: "broken", reason: "error" },
        { thumb: null, storage: null },
      ),
    ).toBe("none");
    expect(await rowOf(A)).toMatchObject({
      calibration: "calibrated",
      thumb_key: MANUAL_THUMB_KEY,
    });
  });

  it("retry: 何も変えない", async () => {
    await seed(A);
    expect(
      await applyCheck(h.db, A, { kind: "retry", reason: "404" }, { thumb: null, storage: null }),
    ).toBe("none");
    expect(await rowOf(A)).toEqual({ thumb_key: null, calibration: "uncalibrated", e: "none" });
  });

  it("ジョブが走っている間に公開をやめた投稿には、何も入れない", async () => {
    await seed(A);
    await h.db.execute(sql`update posts set base_status = 'unpublished' where id = ${A}`);
    const st = storage();
    expect(await applyCheck(h.db, A, { kind: "ok" }, { thumb: WEBP, storage: st })).toBe("none");
    expect((await rowOf(A))?.thumb_key).toBeNull();
  });
});
