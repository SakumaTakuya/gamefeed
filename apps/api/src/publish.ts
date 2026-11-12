/**
 * `publish_game` の本体（mcp.md A.3 / A.6 / A.7 / A.8 / A.10）。
 *
 * MCP サーバ（mcp.ts）が同じプロセスで呼ぶ関数で、HTTP も MCP も知らない。
 * 処理順は mc#A.6 の番号どおり: 1〜10 を 1 トランザクションで行い、11（R2）と 12（KV）はコミット後。
 * R2 と KV は境界の外側なのでインターフェースで受ける（実体は #89、テストはメモリの fake）。
 */

import { createHash } from "node:crypto";
import { type Finding, graphemeCount, staticCheck, utf8ByteLength } from "@gamefeed/domain";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { games, posts, users } from "./db/schema.ts";
import { ulid } from "./id.ts";
import { ensureUser } from "./users.ts";

// ---- 定数（暫定値は定数として持つ） ---------------------------------------------------------

/** これ以上なら公開時に `public`、未満なら `limited`（mo#A.2、暫定） */
export const TRUST_PUBLIC_THRESHOLD = 30;
/** 新規の下書きの 1 日の上限。`trust_score` が閾値未満 / 以上（mo#A.5、暫定） */
export const PUBLISH_LIMIT_NEW = 5;
export const PUBLISH_LIMIT = 30;
/** 1 ユーザーの下書きの上限（dm#A.5 I11） */
export const DRAFT_LIMIT = 10;
/** `title` / `prompt` の上限（文字数。mc#A.3、暫定） */
export const TITLE_MAX = 40;
export const PROMPT_MAX = 1000;
/** 「当日」の境界は JST の 0 時（mc#A.6 の 4、B.8） */
export const DAY_OFFSET_MS = 9 * 60 * 60 * 1000;
/** KV の書き込みを試す回数（mc#A.6 の 12「失敗はリトライ」。それでも駄目なら `storage_failed`） */
export const KV_ATTEMPTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `now` を含む日の始まり（DAY_OFFSET_MS の時間帯での 0 時） */
export function dayStart(now: Date): Date {
  const shifted = now.getTime() + DAY_OFFSET_MS;
  return new Date(shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - DAY_OFFSET_MS);
}

// ---- 境界（mc#A.8、se#A.5） ----------------------------------------------------------------

/** R2。`PutObject` だけ。同じキーへの上書きは無害（内容がハッシュで決まる） */
export interface GameStorage {
  put(key: string, html: string): Promise<void>;
}

/** KV `serve:<post_id>` の値（se#A.5） */
export interface ServeValue {
  hash: string;
  status: "draft" | "ok" | "no";
}
export interface ServeKv {
  put(postId: string, value: ServeValue): Promise<void>;
}

export interface PublishDeps {
  db: Db;
  /** 未設定（`R2_*` なし）なら `not_configured`（mc#A.2） */
  storage?: GameStorage;
  kv?: ServeKv;
  /** 未設定のときに足りない環境変数の名前（`not_configured` の文に入れる。値は入れない） */
  storageMissing?: string[];
  /** 試遊 URL・ゲームページの元（末尾スラッシュなし）。mc#A.9 */
  appOrigin: string;
  now: () => Date;
}

// ---- 入出力（mc#A.3、A.10） ----------------------------------------------------------------

export interface PublishInput {
  html: string;
  title?: string | undefined;
  prompt?: string | undefined;
  post_id?: string | undefined;
  publish?: boolean | undefined;
}

/** 投稿状態（`post_status` ビュー。`restricted` を含む 6 値のうち `removed` 以外が返りうる） */
export type PostStatus = "draft" | "limited" | "public" | "unpublished" | "restricted" | "removed";

export interface PublishOutput {
  post_id: string;
  status: PostStatus;
  url: string;
  warnings: { code: string; message: string }[];
  reused: boolean;
}

export type ToolErrorCode =
  | "rejected"
  | "not_found"
  | "invalid_state"
  | "limit"
  | "post_restricted"
  | "storage_failed"
  | "not_configured"
  | "invalid"
  /** mc#A.10 にはない内部用。`users.status = banned` は HTTP の 401 にする（mc#A.2）ので、ツールの結果にしない */
  | "banned";

export interface ToolError {
  code: ToolErrorCode;
  /** 日本語。AI がそのまま作者に見せられる文 */
  message: string;
  errors?: { code: string; message: string; fix: string; line?: number }[];
  reason?: "drafts" | "rate";
}

export type ToolFailure = { ok: false; error: ToolError };
export type ToolOutcome<T> = { ok: true; value: T } | ToolFailure;
export type PublishResult = ToolOutcome<PublishOutput>;

export const fail = (
  code: ToolErrorCode,
  message: string,
  extra: Partial<ToolError> = {},
): ToolFailure => ({
  ok: false,
  error: { code, message, ...extra },
});

/** 他人の投稿と存在しない ID で同じ応答にする（C6） */
export const NOT_FOUND =
  "その post_id の投稿は見つかりません。list_my_games で自分の投稿を確認してください。";

/**
 * ツールの先頭（mc#A.5、A.6 の 1）: `ensureUser` し、`users` を `FOR SHARE` して status を見る（I3: BAN と直列化）。
 * `banned` は失敗を返す。`post_restricted` の扱いはツールごとに違うので呼び出し側が見る。
 */
export async function lockUser(
  tx: Db,
  userId: string,
): Promise<{ status: "active" | "post_restricted"; trustScore: number } | ToolFailure> {
  await ensureUser(tx, userId);
  const [me] = await tx
    .select({ status: users.status, trustScore: users.trustScore })
    .from(users)
    .where(eq(users.id, userId))
    .for("share");
  if (!me) throw new Error(`lockUser: users に ${userId} がいない`);
  if (me.status === "banned") return fail("banned", "このアカウントは利用できません。");
  return { status: me.status, trustScore: me.trustScore };
}

// ---- 本体 ---------------------------------------------------------------------------------

interface Committed {
  postId: string;
  hash: string;
  status: PostStatus;
  warnings: { code: string; message: string }[];
  reused: boolean;
}

export async function publishGame(
  deps: PublishDeps,
  userId: string,
  input: PublishInput,
): Promise<PublishResult> {
  const { db, storage, kv } = deps;
  if (!storage || !kv) {
    const names = deps.storageMissing?.length
      ? `（未設定: ${deps.storageMissing.join(", ")}）`
      : "";
    return fail(
      "not_configured",
      `GameFeed の保存先がまだ設定されていません。運営に連絡してください。${names}`,
    );
  }

  // 入力の型・長さ（mc#A.3）。html の 128 KB は静的検査の SIZE が直し方つきで拒否する
  if (typeof input.html !== "string" || input.html.length === 0) {
    return fail("invalid", "html が空です。ゲームの index.html の全文を渡してください。");
  }
  const givenTitle = input.title?.trim();
  if (givenTitle !== undefined && !titleOk(givenTitle)) {
    return fail("invalid", `title は 1〜${TITLE_MAX} 文字にしてください。`);
  }
  const prompt = input.prompt ?? "";
  if (graphemeCount(prompt) > PROMPT_MAX) {
    return fail("invalid", `prompt は ${PROMPT_MAX} 文字までです。短くしてください。`);
  }

  const html = input.html;
  const now = deps.now();
  const hash = createHash("sha256").update(html, "utf8").digest("hex");
  const r2Key = `games/${hash}.html`;

  const committed = await db.transaction(async (txn): Promise<Committed | PublishResult> => {
    const tx = txn as unknown as Db;

    // 1. ensureUser と users.status（I3: FOR SHARE で BAN と直列化する）
    const me = await lockUser(tx, userId);
    if ("ok" in me) return me;
    // 同じユーザーの publish_game を直列にする。下書きの件数（I11）と同一内容の確認が並行して抜けないように
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`publish:${userId}`}, 0))`,
    );
    if (me.status === "post_restricted") {
      return fail(
        "post_restricted",
        "このアカウントは現在、新しい投稿と公開が制限されています。運営に連絡してください。",
      );
    }

    // 2. post_id があれば自分の draft であること
    let target: { id: string } | undefined;
    if (input.post_id !== undefined) {
      const [p] = await tx
        .select({ id: posts.id, userId: posts.userId, baseStatus: posts.baseStatus })
        .from(posts)
        .where(eq(posts.id, input.post_id))
        .for("update");
      if (!p || p.userId !== userId) return fail("not_found", NOT_FOUND);
      if (p.baseStatus !== "draft") {
        return fail(
          "invalid_state",
          "この投稿は下書きではないので内容を置き換えられません。公開後は内容を変えられないので、post_id を付けずに新しい下書きとして投稿してください。",
        );
      }
      target = { id: p.id };
    }

    // 3. 同一内容（mc#A.7）。上限と静的検査より先
    if (!target) {
      const same = await tx
        .select({ id: posts.id, baseStatus: posts.baseStatus })
        .from(posts)
        .where(and(eq(posts.userId, userId), eq(posts.gameHash, hash)))
        .orderBy(desc(posts.updatedAt), desc(posts.id))
        .for("update");
      if (same.some((p) => p.baseStatus === "removed")) {
        return fail(
          "invalid_state",
          "同じ内容の投稿が運営によって削除されています。この内容は再投稿できません。",
        );
      }
      const hit = same[0];
      if (hit) {
        const [g] = await tx.select({ meta: games.meta }).from(games).where(eq(games.hash, hash));
        const meta = (g?.meta ?? {}) as {
          title?: string;
          warnings?: { code: string; message: string }[];
        };
        if (hit.baseStatus === "draft") {
          const title = givenTitle ?? meta.title ?? "";
          if (!titleOk(title)) return fail("invalid", titleTooLong());
          await tx.update(posts).set({ title, prompt, updatedAt: now }).where(eq(posts.id, hit.id));
        }
        return {
          postId: hit.id,
          hash,
          status: await statusOf(tx, hit.id),
          warnings: meta.warnings ?? [],
          reused: true,
        };
      }
    }

    // 4. 上限（新規だけ。置き換えは数えない）
    if (!target) {
      const [d] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(posts)
        .where(and(eq(posts.userId, userId), eq(posts.baseStatus, "draft")));
      if ((d?.n ?? 0) >= DRAFT_LIMIT) {
        return fail(
          "limit",
          `下書きが ${DRAFT_LIMIT} 件あります。「作る」ページで不要な下書きを消すか、既存の下書きの post_id を付けて置き換えてください。`,
          { reason: "drafts" },
        );
      }
      const limit = me.trustScore < TRUST_PUBLIC_THRESHOLD ? PUBLISH_LIMIT_NEW : PUBLISH_LIMIT;
      const [t] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(posts)
        .where(and(eq(posts.userId, userId), gte(posts.createdAt, dayStart(now))));
      if ((t?.n ?? 0) >= limit) {
        return fail(
          "limit",
          `今日の新しい投稿は ${limit} 件までです。明日また投稿するか、既存の下書きの post_id を付けて置き換えてください。`,
          { reason: "rate" },
        );
      }
    }

    // 5. 静的検査。拒否なら何も書かない（C2）
    const check = staticCheck(html);
    if (!check.ok) {
      return fail(
        "rejected",
        "GameFeed の規約に合わない点があります。errors[].fix のとおりに直して再投稿してください。",
        {
          errors: check.errors.map(errorOut),
        },
      );
    }
    const title = givenTitle ?? check.meta.title;
    if (!titleOk(title)) return fail("invalid", titleTooLong());
    // 9. warnings（games.meta にも同じ形で残し、同一内容で戻ったときに返せるようにする）
    const warnings = check.warnings.map((w) => ({ code: w.code, message: w.message }));

    // 6. games（内容。ハッシュで重複排除。stored_at は R2 に置けてから）
    await tx
      .insert(games)
      .values({
        hash,
        size: utf8ByteLength(html),
        r2Key,
        meta: {
          title: check.meta.title,
          verb: check.meta.verb,
          input: check.meta.input,
          duration_frames: check.meta.duration,
          target: check.meta.target,
          deterministic: check.deterministic,
          warnings,
        },
        createdAt: now,
      })
      .onConflictDoNothing();

    // 7. posts
    let postId: string;
    if (target) {
      postId = target.id;
      await tx
        .update(posts)
        .set({ gameHash: hash, title, prompt, updatedAt: now })
        .where(eq(posts.id, postId));
    } else {
      postId = ulid(now.getTime());
      await tx.insert(posts).values({
        id: postId,
        userId,
        gameHash: hash,
        title,
        prompt,
        treeId: postId,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 8. 公開（mo#A.2: 公開時点の trust_score で分岐。以後は内容が不変）
    if (input.publish === true) {
      await tx
        .update(posts)
        .set({
          baseStatus: me.trustScore < TRUST_PUBLIC_THRESHOLD ? "limited" : "public",
          publishedAt: now,
        })
        .where(eq(posts.id, postId));
    }

    // 10. コミット
    return { postId, hash, status: await statusOf(tx, postId), warnings, reused: false };
  });

  if ("ok" in committed) return committed;

  // 11. R2。成否は stored_at で判定する（この呼び出しが行を挿入したかどうかではない）
  const [g] = await db.select({ storedAt: games.storedAt }).from(games).where(eq(games.hash, hash));
  if (!g?.storedAt) {
    try {
      await storage.put(r2Key, html);
    } catch (e) {
      // 原因（HTTP ステータスと応答の先頭。秘密は入らない）は運営がログで追う。作者には一般的な文だけ返す
      console.error(`R2 への ${r2Key} の書き込みに失敗した`, e);
      return fail(
        "storage_failed",
        "ゲームの保存に失敗しました。同じ内容でもう一度 publish_game を呼んでください。",
      );
    }
    await db
      .update(games)
      .set({ storedAt: deps.now() })
      .where(and(eq(games.hash, hash), isNull(games.storedAt)));
  }

  // 12. KV（se#A.5）。stored_at が入ってから書く。失敗はリトライし、駄目なら storage_failed
  if (!(await syncServe(db, kv, committed.postId))) {
    // KV に書けなかったか、並行する置き換えで「いまの内容」が R2 に無い。どちらも試遊・配信ができないので、
    // 同じ入力で呼び直させる（同じ投稿に戻り、足りないものだけ書き直す）
    return fail(
      "storage_failed",
      "ゲームは保存しましたが、配信の準備が終わっていません。同じ内容でもう一度 publish_game を呼んでください。",
    );
  }

  return {
    ok: true,
    value: {
      post_id: committed.postId,
      status: committed.status,
      url: `${deps.appOrigin}/${committed.status === "draft" ? "draft" : "g"}/${committed.postId}`,
      warnings: committed.warnings,
      reused: committed.reused,
    },
  };
}

// ---- 補助 ---------------------------------------------------------------------------------

function titleOk(title: string): boolean {
  const n = graphemeCount(title);
  return n >= 1 && n <= TITLE_MAX;
}

const titleTooLong = () =>
  `<title> が ${TITLE_MAX} 文字を超えています。title に 1〜${TITLE_MAX} 文字の題を渡すか、<title> を短くしてください。`;

function errorOut(f: Finding): { code: string; message: string; fix: string; line?: number } {
  return {
    code: f.code,
    message: f.message,
    fix: f.fix,
    ...(f.line !== undefined ? { line: f.line } : {}),
  };
}

/**
 * KV `serve:<post_id>` を書く（se#A.5）。DB のコミット後に呼ぶ。
 * 失敗はリトライし、それでも駄目なら false を返す（例外にしない）。
 * 呼び出し側は false を `storage_failed` として返し、同じ入力の呼び直しで書き直せるようにする。
 */
async function writeServe(kv: ServeKv, postId: string, value: ServeValue): Promise<boolean> {
  for (let i = 0; i < KV_ATTEMPTS; i++) {
    try {
      await kv.put(postId, value);
      return true;
    } catch (e) {
      if (i === KV_ATTEMPTS - 1) console.error(`KV serve:${postId} の書き込みに失敗した`, e);
    }
  }
  return false;
}

/**
 * KV `serve:<post_id>` を、いま DB に確定している状態に合わせる（se#A.5）。DB のコミット後に呼ぶ。
 *
 * 呼び出し側が自分のトランザクションで見た状態をそのまま書くと、並行する操作と KV の書き込み順が入れ替わりうる
 * （公開済みに戻った publish_game の `ok` が、後から確定した unpublish_game の `no` を上書きする）。
 * 投稿ごとの advisory lock の中で状態を読み直して書くので、最後に書く者は必ず最新の確定状態を書く。
 * 行がもう無い（下書きが消えた）なら何もしない。書けなかったら false。
 * いまの内容が R2 に無い（`games.stored_at` が NULL）間も書かずに false（mc#A.6 の 12、C7）。
 */
export async function syncServe(db: Db, kv: ServeKv, postId: string): Promise<boolean> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`serve:${postId}`}, 0))`);
    // 内容・R2 の有無・状態は 1 文で読む。READ COMMITTED では文ごとにスナップショットが変わるので、
    // 分けて読むと間に確定した置き換えで「古い hash と新しい状態」の組ができる
    const rows = (await tx.execute(sql`
      select p.game_hash as hash, g.stored_at as stored_at, ps.status as status
      from posts p
      join games g on g.hash = p.game_hash
      join post_status ps on ps.id = p.id
      where p.id = ${postId}
    `)) as unknown as { hash: string; stored_at: Date | null; status: PostStatus }[];
    const p = rows[0];
    if (!p) return true;
    const status = serveStatus(p.status);
    // C7: R2 に無い内容を KV に指させない。並行する置き換えが DB を先に確定させ、その R2 が失敗（または途中）のときに起きる。
    // 呼び出し側は storage_failed を返し、呼び直しが R2 から置き直す。止める方向（no）は内容を配らないので書く
    if (status !== "no" && !p.stored_at) return false;
    return writeServe(kv, postId, { hash: p.hash, status });
  });
}

/** 投稿状態（dm#A.4 の `post_status` ビュー） */
export async function statusOf(tx: Db, postId: string): Promise<PostStatus> {
  const rows = (await tx.execute(
    sql`select status from post_status where id = ${postId}`,
  )) as unknown as { status: PostStatus }[];
  const status = rows[0]?.status;
  if (!status) throw new Error(`publishGame: post_status に ${postId} がない`);
  return status;
}

/** se#A.5 の対応: `limited` / `public` → ok、`draft` → draft、それ以外 → no */
export function serveStatus(status: PostStatus): ServeValue["status"] {
  if (status === "limited" || status === "public") return "ok";
  if (status === "draft") return "draft";
  return "no";
}
