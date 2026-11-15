/**
 * 結果の受理（scoring.md A.2）。`PUT /api/sessions/{id}/result` の本体。
 *
 * 受理の条件・分布に入る条件・校正の検査は `@gamefeed/domain` の `checkResult` / `entersDistribution` /
 * `calibrationCheck` が決め、ここはセッションと分布を DB から読み、1 トランザクションで書く。
 * - `open` からの遷移は高々 1 回（I7）。セッションの行ロックで直列にし、2 回目以降は `session_not_open`
 * - 拒否した結果はセッションを `skipped` にする（Host はその手番を skip にする。run#A.6）
 * - 偏差値は受理時点の分布（この結果を含めない）に対して出す（sc#A.5）。ミスは凍結した `miss_below` で判定し直す
 * - 分布（`post_stats`）はその行のロックの中で更新し、1 主体 5 件の窓から押し出された結果を外す（I15）
 * - 未校正のゲームは n ≥ 20 で `calibrated` / `invalid` に進み、`limited` は校正済みで `public` に昇格する（sc#A.7、mo#A.2）
 * - 入力ログは受理の確定後に R2 へ置き、置けたときだけ `log_key` を入れる（dm#A.6）
 * 応答のステータス・拒否後の状態・新作扱いの手番の値などは文書に無く、#145 の案で実装している。
 */

import { gzipSync } from "node:zlib";
import {
  CALIBRATION_MIN_PLAYS,
  calibrationCheck,
  checkResult,
  DISTRIBUTION_MIN_FRAMES_RATIO,
  DISTRIBUTION_WINDOW,
  deviation,
  entersDistribution,
  isMiss,
  type ResultRejection,
  ratioOf,
} from "@gamefeed/domain";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { postStats } from "./db/schema.ts";

/** 入力ログの置き場（R2）。key は `replays/{session_id}.json.gz`、本文は gzip 済みの JSON（dm#A.6） */
export interface ReplayStorage {
  putReplay(key: string, gz: Uint8Array): Promise<void>;
}

export interface ResultDeps {
  db: Db;
  now: () => Date;
  /** 未設定（`R2_*` なし）なら入力ログを保存せず、`log_key` は NULL のまま */
  replays?: ReplayStorage;
}

/** 入力ログのキー（dm#A.3 `sessions.log_key`） */
export const replayKey = (sessionId: string): string => `replays/${sessionId}.json.gz`;

export type Calibration = "uncalibrated" | "calibrated" | "review" | "invalid";

/** sc#A.2 の応答。表示用で、Host は進行に使わない */
export interface AcceptedResult {
  /** 受理時の偏差値。校正中・新作扱いの手番・skip（timeout / error）は null */
  deviation: number | null;
  /** 発行時に凍結した `miss_below` で判定した値。Host の判定と一致する（run#A.7） */
  miss: boolean;
  /** この結果を反映した後の、ゲームの校正状態 */
  calibration: Calibration;
  /** 偏差値を出さないときの `min(1, score / target)`。skip は null */
  ratio: number | null;
}

export type SubmitResult =
  | { ok: true; value: AcceptedResult | { skipped: true } }
  | { ok: false; error: "session_not_found" | "session_not_open" }
  | { ok: false; error: "invalid_result"; reason: ResultRejection };

export interface SubmitInput {
  sessionId: string;
  actorId: string;
  /** リクエストの本文（JSON のオブジェクト） */
  body: unknown;
}

interface SessionRow extends Record<string, unknown> {
  post_id: string;
  seed: string | number;
  state: "open" | "submitted" | "skipped" | "abandoned";
  speed: string;
  time_limit: number;
  miss_below: number | null;
  is_new: boolean;
  author: boolean;
  issued_at: Date | string;
  target: number;
}

/** 昇順の配列から value を 1 つ外す。無ければそのまま */
function without(sorted: readonly number[], value: number): number[] {
  const i = sorted.indexOf(value);
  return i < 0 ? [...sorted] : [...sorted.slice(0, i), ...sorted.slice(i + 1)];
}

/**
 * 結果を受理する。ほかの主体のセッションと存在しないセッションは `session_not_found`（区別しない）。
 */
export async function submitResult(deps: ResultDeps, input: SubmitInput): Promise<SubmitResult> {
  let replay: { seed: number; speed: number; inputs: unknown[][] } | undefined;
  const result = await acceptResult(deps, input, (r) => {
    replay = r;
  });
  if (replay && deps.replays) {
    // 再実行（sc#A.3）の材料。受理は確定しているので、置けなくても結果は返す（log_key が NULL のまま残る）
    const key = replayKey(input.sessionId);
    try {
      await deps.replays.putReplay(key, gzipSync(JSON.stringify(replay)));
      await deps.db.execute(
        sql`update sessions set log_key = ${key} where id = ${input.sessionId}`,
      );
    } catch (e) {
      console.error(`submitResult: 入力ログ ${key} を保存できなかった`, e);
    }
  }
  return result;
}

/** 受理のトランザクション。受理した結果の入力ログは onAccepted に渡す（R2 への保存はコミットの後） */
function acceptResult(
  deps: ResultDeps,
  input: SubmitInput,
  onAccepted: (replay: { seed: number; speed: number; inputs: unknown[][] }) => void,
): Promise<SubmitResult> {
  return deps.db.transaction(async (txn): Promise<SubmitResult> => {
    const tx = txn as unknown as Db;
    const { sessionId } = input;

    // 同じセッションへの提出を直列にする。ロックを取った時点で open でなければ、先の提出が確定している
    const [session] = await tx.execute<SessionRow>(sql`
      select s.post_id, s.seed, s.state, s.speed, s.time_limit, s.miss_below, s.is_new, s.author, s.issued_at,
             (g.meta->>'target')::int as target
      from sessions s join games g on g.hash = s.game_hash
      where s.id = ${sessionId} and s.actor_id = ${input.actorId}
      for update of s`);
    if (!session) return { ok: false, error: "session_not_found" };
    if (session.state !== "open") return { ok: false, error: "session_not_open" };

    const now = deps.now();
    const speed = Number(session.speed);
    const check = checkResult(
      { timeLimit: session.time_limit, speed, issuedAtMs: new Date(session.issued_at).getTime() },
      input.body,
      now.getTime(),
    );
    if (!check.ok) {
      // 拒否したセッションは無効。Host と同じく skip として数えられるよう skipped にする（run#A.6）
      await tx.execute(sql`
        update sessions set state = 'skipped', verdict = ${check.flagged ? "flagged" : "provisional"}::verdict
        where id = ${sessionId} and state = 'open'`);
      return { ok: false, error: "invalid_result", reason: check.reason };
    }
    if (check.kind === "skipped") {
      await tx.execute(
        sql`update sessions set state = 'skipped' where id = ${sessionId} and state = 'open'`,
      );
      return { ok: true, value: { skipped: true } };
    }

    const { score, frames, via } = check;
    const enters = entersDistribution({
      verdict: "provisional",
      speed,
      author: session.author,
      frames,
      timeLimit: session.time_limit,
    });
    // 分布を書き換える結果は post_stats の行ロックで直列にする（同じゲームへの同時の受理で更新を失わない）
    if (enters) {
      await tx.execute(
        sql`insert into post_stats (post_id) values (${session.post_id}) on conflict do nothing`,
      );
    }
    const [stat] = await tx.execute<{ scores: number[] }>(
      enters
        ? sql`select scores from post_stats where post_id = ${session.post_id} for update`
        : sql`select scores from post_stats where post_id = ${session.post_id}`,
    );
    // post_stats.scores は昇順（dm#A.3）。並びが崩れていても順位がずれないよう、ここで並べ直す
    const dist = [...(stat?.scores ?? [])].sort((a, b) => a - b);
    // 校正状態は分布のロックの後に読む（校正の遷移は同じロックの中で起きる）
    const [post] = await tx.execute<{ calibration: Calibration }>(
      sql`select calibration from posts where id = ${session.post_id}`,
    );
    if (!post) throw new Error(`submitResult: posts に ${session.post_id} がない`);
    let calibration = post.calibration;

    // 偏差値を出すのは、成績に入る手番（新作扱いでない）の、校正済みで分布が足りているゲームだけ。
    // timeout / error は遊ぶ側では skip なので、偏差値も比も出さない（sc#A.9）
    const scored = via === "guest";
    const calibrated =
      !session.is_new && calibration === "calibrated" && dist.length >= CALIBRATION_MIN_PLAYS;
    const value: AcceptedResult = {
      deviation: scored && calibrated ? deviation(score, dist) : null,
      miss: isMiss({ via, score, missBelow: session.miss_below }),
      calibration,
      ratio: scored && !calibrated ? ratioOf(score, session.target) : null,
    };

    await tx.execute(sql`
      update sessions
      set state = 'submitted', via = ${via}::session_via, score = ${score}, frames = ${frames},
          deviation = ${value.deviation === null ? null : value.deviation.toFixed(1)},
          submitted_at = ${now.toISOString()}::timestamptz
      where id = ${sessionId} and state = 'open'`);

    if (enters) {
      // 1 主体 5 件の窓: この主体の、分布に入っている直近 5 件のうち最古が押し出される（sc#A.4）
      const [pushed] = await tx.execute<{ score: number }>(sql`
        select score from sessions
        where post_id = ${session.post_id} and actor_id = ${input.actorId}
          and state = 'submitted' and id <> ${sessionId}
          and speed = 1 and author = false and verdict in ('provisional', 'accepted')
          and frames >= ${DISTRIBUTION_MIN_FRAMES_RATIO}::numeric * time_limit
        order by submitted_at desc, id desc
        offset ${DISTRIBUTION_WINDOW - 1} limit 1`);
      const scores = (pushed ? without(dist, pushed.score) : dist).concat(score);
      scores.sort((a, b) => a - b);
      await tx
        .update(postStats)
        .set({ n: scores.length, scores, updatedAt: now })
        .where(eq(postStats.postId, session.post_id));

      // 校正（sc#A.7）。未校正からだけ進む。invalid は終端で、校正済みはここでは変えない
      const decided = calibration === "uncalibrated" ? calibrationCheck(scores) : null;
      if (decided) {
        await tx.execute(
          sql`update posts set calibration = ${decided}::calibration where id = ${session.post_id}`,
        );
        calibration = value.calibration = decided;
      }
      if (decided === "calibrated") {
        // limited は校正済みになる遷移で public に昇格する。制限中と upheld の通報がある投稿は昇格しない（mo#A.2）
        await tx.execute(sql`
          update posts set base_status = 'public'
          where id = ${session.post_id} and base_status = 'limited'
            and exists (select 1 from post_status ps where ps.id = posts.id and ps.status = 'limited')
            and not exists (
              select 1 from reports r where r.post_id = posts.id and r.resolution = 'upheld')`);
      }
    }
    onAccepted({ seed: Number(session.seed), speed, inputs: check.inputs });
    return { ok: true, value };
  });
}
