/**
 * `thumb_key` を手で入れる運用の道具（#185）の integration テスト。Postgres は本物。
 * 公開直後のジョブ（mc#A.9）ができるまで、公開した未校正の投稿を新作枠に入れるために使う。
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.ts";
import { MANUAL_THUMB_KEY, setManualThumb } from "../../src/manual-thumb.ts";
import { useRunHarness } from "../helpers/run-harness.ts";

const url = process.env.DATABASE_URL;
if (!url)
  console.warn("DATABASE_URL が未設定なので manual-thumb の integration テストを skip します");
const dbSuite = url ? describe : describe.skip;

dbSuite("setManualThumb（#185。mc#A.9 のジョブができるまでの代わり）", () => {
  const h = useRunHarness(url as string);

  const ID = "01M782MV00TMYMTHTGG5C6KS3A";
  const ID2 = "01M782MV00TMYMTHTGG5C6KS3B";

  /** サムネの無い投稿を置く（公開直後のジョブが無い今の本番と同じ状態）。本番と同じく ID は ULID */
  async function seed(
    o: {
      id?: string;
      status?: "draft" | "limited" | "public";
      calibration?: "uncalibrated" | "invalid";
      thumbKey?: string;
    } = {},
  ): Promise<string> {
    const id = o.id ?? ID;
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
  async function thumbOf(id: string): Promise<string | null> {
    const [row] = await h.db.execute<{ thumb_key: string | null }>(
      sql`select thumb_key from posts where id = ${id}`,
    );
    return row?.thumb_key ?? null;
  }

  it("公開した未校正の投稿に thumb_key を入れると、新作枠（new）に入る", async () => {
    const id = await seed({ status: "limited" });
    expect(await setManualThumb(h.db, id)).toEqual({
      ok: true,
      changed: true,
      status: "limited",
      calibration: "uncalibrated",
      eligibility: "new",
    });
    expect(await thumbOf(id)).toBe(MANUAL_THUMB_KEY);
  });

  it("public でも同じ", async () => {
    const id = await seed({ status: "public" });
    expect(await setManualThumb(h.db, id)).toMatchObject({
      ok: true,
      changed: true,
      status: "public",
      eligibility: "new",
    });
  });

  it("もう thumb_key が入っている投稿は変えない（本物のサムネを上書きしない）。何度実行しても同じ", async () => {
    const id = await seed({ thumbKey: "thumbs/real.webp" });
    expect(await setManualThumb(h.db, id)).toMatchObject({ ok: true, changed: false });
    expect(await thumbOf(id)).toBe("thumbs/real.webp");

    const bare = await seed({ id: ID2 });
    expect(await setManualThumb(h.db, bare)).toMatchObject({ ok: true, changed: true });
    expect(await setManualThumb(h.db, bare)).toMatchObject({
      ok: true,
      changed: false,
      eligibility: "new",
    });
  });

  it("下書きには入れない（公開直後のジョブの代わりなので、公開した投稿だけ）", async () => {
    const id = await seed({ status: "draft" });
    expect(await setManualThumb(h.db, id)).toEqual({
      ok: false,
      error: "not_published",
      status: "draft",
    });
    expect(await thumbOf(id)).toBeNull();
  });

  it("入れてもランに出ない投稿（校正状態が invalid）は、入れたうえで eligibility が none だと分かる", async () => {
    const id = await seed({ status: "public", calibration: "invalid" });
    expect(await setManualThumb(h.db, id)).toEqual({
      ok: true,
      changed: true,
      status: "public",
      calibration: "invalid",
      eligibility: "none",
    });
  });

  it("無い投稿は not_found、ULID の形でない ID は invalid_id（SQL を投げない）", async () => {
    await seed();
    expect(await setManualThumb(h.db, "01M782MV00TMYMTHTGG5C6KS3T")).toEqual({
      ok: false,
      error: "not_found",
    });
    for (const bad of [
      "",
      "abc",
      "01m782mv00tmymthtgg5c6ks3t",
      "01M782MV00TMYMTHTGG5C6KS3T; drop",
    ]) {
      expect(await setManualThumb(h.db, bad), bad).toEqual({ ok: false, error: "invalid_id" });
    }
  });
});
