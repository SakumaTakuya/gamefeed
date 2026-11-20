/**
 * `thumb_key` を手で入れる（#185）。運用の道具で、API からは呼ばない。
 *
 * 公開後の静止サムネは公開直後のジョブが作って `thumb_key` に入れ、入るまで新作枠に入らない（mc#A.9、
 * dm#A.4 の `post_eligibility`）。そのジョブがまだ無いので、公開しただけの未校正の投稿はランに出ない。
 * ジョブができるまでの間、オーナーが投稿を選んで目印の値を入れる（Actions の `set-thumb-key`）。
 * 仕様は変えていない。ジョブが「固まるゲームを新作枠に出さない」ために見ることを、人が試遊で見て代わる。
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";

/** 手で入れたことが分かる目印。R2 のキーではない。ジョブができたら本物のキーで置き換える */
export const MANUAL_THUMB_KEY = "manual";

/** ULID（Crockford Base32、26 文字、大文字） */
const POST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type ManualThumbResult =
  | {
      ok: true;
      /** false: もう `thumb_key` が入っていたので変えなかった */
      changed: boolean;
      /** 投稿状態（dm#A.4 の `post_status`） */
      status: string;
      calibration: string;
      /** この後、ランに出せるか（normal / new / none） */
      eligibility: string;
    }
  | { ok: false; error: "invalid_id" | "not_found" }
  /** 公開していない（draft / unpublished / removed / restricted）。入れない */
  | { ok: false; error: "not_published"; status: string };

/**
 * 公開した（`limited` / `public`）投稿の `thumb_key` が NULL なら目印の値を入れる。
 * もう入っている値は変えない（本物のサムネを上書きしない）ので、何度実行しても同じ。
 */
export async function setManualThumb(db: Db, postId: string): Promise<ManualThumbResult> {
  if (!POST_ID.test(postId)) return { ok: false, error: "invalid_id" };
  return db.transaction(async (tx) => {
    const [post] = await tx.execute<{ status: string }>(sql`
      select s.status from posts p join post_status s on s.id = p.id
      where p.id = ${postId} for update of p`);
    if (!post) return { ok: false, error: "not_found" };
    if (post.status !== "limited" && post.status !== "public") {
      return { ok: false, error: "not_published", status: post.status };
    }
    const updated = await tx.execute(sql`
      update posts set thumb_key = ${MANUAL_THUMB_KEY}
      where id = ${postId} and thumb_key is null returning id`);
    const [after] = await tx.execute<{ calibration: string; eligibility: string }>(sql`
      select p.calibration::text as calibration, e.eligibility
      from posts p join post_eligibility e on e.id = p.id where p.id = ${postId}`);
    if (!after) throw new Error("post_eligibility が行を返さなかった");
    return {
      ok: true,
      changed: updated.length > 0,
      status: post.status,
      calibration: after.calibration,
      eligibility: after.eligibility,
    };
  });
}
