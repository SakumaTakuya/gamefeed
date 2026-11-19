/**
 * 手番の結果を記録に足す（run.md A.3、scoring.md A.2）。`PUT /api/runs/{id}/turns/{t}` の本体。
 *
 * 進行は Host が計画から決め、サーバは推測しない（run#B.1）。ここがするのは、記録の次の手番（`t = settled`）の
 * 結果を 1 つ足すことだけ。手番の位置・速度・`miss_below`・`time_limit`・seed は、計画と記録から
 * `@gamefeed/domain` の `turnAt` / `turnSeed` で求め直す（Host の申告は使わない）。
 * - 同じランへの書き込みは `runs` の行ロックで直列にする。`sessions` に 1 行入れ、同じトランザクションで `settled` を進める（I7）
 * - 記録にある手番（`t < settled`）は本文を見ずに、保存した値から同じ内容を返す。先の手番は 409 `out_of_order`
 * - 足した結果で 3 回目のミス・3 本目の読み込みの skip・次の手番が無い、のどれかになったら、その場でランを閉じて凍結する
 * - 偏差値は受理時点の分布（この結果を含めない）に対して出す（sc#A.5）。ミスは計画の `miss_below` で判定する（run#A.7）
 * - 遊んだ結果は分布、満了と `error` は失敗の数に入れ、1 主体 5 件の窓から押し出された結果を外す（sc#A.4、I15）
 * - 未校正のゲームは n + f ≥ 20 から検査して `calibrated` / `invalid` に進み、`limited` は校正済みで `public` に昇格する（sc#A.7、mo#A.2）
 * - 入力ログは確定の後に R2 へ置き、置けたときだけ `log_key` を入れる（dm#A.6）
 * 誰が送れるか、偏差値を出す条件、`calibration` の時点、窓の数え方などは文書に無く、#161 の C の案で実装している。
 */

import { gzipSync } from "node:zlib";
import {
  CALIBRATION_MIN_PLAYS,
  calibrationVerdict,
  checkPlayed,
  DISTRIBUTION_MIN_FRAMES_RATIO,
  DISTRIBUTION_WINDOW,
  deviation,
  logState,
  outcomeOf,
  type PlayedRejection,
  playedSeconds,
  ratioOf,
  readTurnResult,
  serverRealtimeOk,
  tallyOf,
  turnAt,
  turnSeed,
} from "@gamefeed/domain";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { postStats, runs, sessions } from "./db/schema.ts";
import { ulid } from "./id.ts";
import { deviationOfRow, freezeRun, type LogRow, openRun, outcomeOfRow } from "./run-log.ts";

/** 入力ログの置き場（R2）。key は `replays/{session_id}.json.gz`、本文は gzip 済みの JSON（dm#A.6） */
export interface ReplayStorage {
  putReplay(key: string, gz: Uint8Array): Promise<void>;
}

export interface TurnDeps {
  db: Db;
  now: () => Date;
  /** 未設定（`R2_*` なし）なら入力ログを保存せず、`log_key` は NULL のまま */
  replays?: ReplayStorage;
}

/** 入力ログのキー（dm#A.3 `sessions.log_key`） */
export const replayKey = (sessionId: string): string => `replays/${sessionId}.json.gz`;

export type DeviceKind = "ios" | "android" | "other";

/** 結果を送ったリクエストの User-Agent から端末の種類を決める（dm#A.3 `sessions.device_kind`。sc#A.7 の端末差に使う） */
export function deviceKindOf(userAgent: string | undefined | null): DeviceKind {
  if (!userAgent) return "other";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "other";
}

/** パスの `{t}` を手番番号として読む。0 以上の整数の 10 進表記でなければ null（400 `invalid_request`） */
export function parseTurn(value: string): number | null {
  return /^(0|[1-9][0-9]{0,3})$/.test(value) ? Number(value) : null;
}

export type Calibration = "uncalibrated" | "calibrated" | "review" | "invalid";

/** run#A.3 の応答。表示用で、Host は進行に使わない */
export interface SettledTurn {
  /** 記録の長さ（次に足す手番の番号） */
  settled: number;
  /** 受理時の偏差値。校正中・新作扱いの手番・skip は null */
  deviation: number | null;
  /** 計画の `miss_below` で判定した値。Host の判定と一致する（run#A.7） */
  miss: boolean;
  /** 足したときは、この結果を反映した後の校正状態。記録にある手番への応答では今の校正状態 */
  calibration: Calibration;
  /** 偏差値を出さない遊んだ結果の `min(1, score / target)`。skip は null */
  ratio: number | null;
}

export type SettleResult =
  | { ok: true; value: SettledTurn }
  | { ok: false; error: "run_not_found" | "invalid_request" }
  | { ok: false; error: "out_of_order" | "run_closed"; settled: number }
  | { ok: false; error: "invalid_result"; reason: PlayedRejection };

export interface SettleInput {
  runId: string;
  /** 手番番号（パスの `{t}`） */
  turn: number;
  actor: { id: string; userId: string | null };
  deviceKind: DeviceKind;
  /** リクエストの本文。JSON として読めなかったときは undefined */
  body: unknown;
}

interface Replay {
  sessionId: string;
  seed: number;
  speed: number;
  inputs: unknown[];
}

interface GameRow extends Record<string, unknown> {
  user_id: string;
  time_limit: number;
  target: number;
}

/** 昇順の配列から value を 1 つ外す。無ければそのまま */
function without(sorted: readonly number[], value: number): number[] {
  const i = sorted.indexOf(value);
  return i < 0 ? [...sorted] : [...sorted.slice(0, i), ...sorted.slice(i + 1)];
}

async function calibrationOf(tx: Db, postId: string): Promise<Calibration> {
  const [post] = await tx.execute<{ calibration: Calibration }>(
    sql`select calibration from posts where id = ${postId}`,
  );
  if (!post) throw new Error(`settleTurn: posts に ${postId} がない`);
  return post.calibration;
}

/** 記録にある手番への応答。保存した値から、足したときと同じ内容を組む（run#A.3） */
async function storedValue(tx: Db, row: LogRow, settled: number): Promise<SettledTurn> {
  const dev = deviationOfRow(row);
  return {
    settled,
    deviation: dev,
    miss: outcomeOfRow(row) === "miss",
    calibration: await calibrationOf(tx, row.post_id),
    ratio:
      row.via === "guest" && dev === null && row.score !== null
        ? ratioOf(row.score, row.target)
        : null,
  };
}

/**
 * 手番 `t` の結果を記録に足す。ランが無いか、その主体のものでなければ `run_not_found`（区別しない）。
 */
export async function settleTurn(deps: TurnDeps, input: SettleInput): Promise<SettleResult> {
  const { result, replay } = await deps.db.transaction((txn) =>
    settleInTx(txn as unknown as Db, deps.now(), input),
  );
  if (replay && deps.replays) {
    // 再実行（sc#A.3）の材料。記録は確定しているので、置けなくても結果は返す（log_key が NULL のまま残る）
    const key = replayKey(replay.sessionId);
    const { seed, speed, inputs } = replay;
    try {
      await deps.replays.putReplay(key, gzipSync(JSON.stringify({ seed, speed, inputs })));
      await deps.db.execute(
        sql`update sessions set log_key = ${key} where id = ${replay.sessionId}`,
      );
    } catch (e) {
      console.error(`settleTurn: 入力ログ ${key} を保存できなかった`, e);
    }
  }
  return result;
}

async function settleInTx(
  tx: Db,
  now: Date,
  input: SettleInput,
): Promise<{ result: SettleResult; replay?: Replay }> {
  const opened = await openRun(tx, { runId: input.runId, actorId: input.actor.id }, now);
  if (!opened) return { result: { ok: false, error: "run_not_found" } };
  const { run, log } = opened;
  const settled = log.length;
  const t = input.turn;

  // run#A.3 の表を上から。記録にある手番は、ランが閉じていても同じ内容を返す。本文は見ない
  const stored = log[t];
  if (stored) return { result: { ok: true, value: await storedValue(tx, stored, settled) } };
  if (run.endedAt !== null) return { result: { ok: false, error: "run_closed", settled } };
  if (t > settled) return { result: { ok: false, error: "out_of_order", settled } };

  // 手番 t の値は計画と記録から決まる（run#A.3）
  const at = turnAt(run.mode, run.deck.length, log.map(outcomeOfRow));
  const postId = at.done ? undefined : run.deck[at.index];
  const gameHash = at.done ? undefined : run.gameHashes[at.index];
  if (at.done || postId === undefined || gameHash === undefined) {
    // 次の手番が無いランは、記録に最後の手番を足したときに閉じている。閉じ損ねていたらここで閉じる
    await freezeRun(tx, run, log, now);
    return { result: { ok: false, error: "run_closed", settled } };
  }
  const speed = at.speed;
  const missBelow = run.missBelow[at.index] ?? null;
  const isNew = run.newIndexes.includes(at.index);
  const seed = turnSeed(run.seed, t);
  const [game] = await tx.execute<GameRow>(sql`
    select p.user_id, (g.meta->>'duration_frames')::int as time_limit, (g.meta->>'target')::int as target
    from posts p, games g
    where p.id = ${postId} and g.hash = ${gameHash}`);
  if (!game) throw new Error(`settleTurn: 計画の投稿か内容が無い: ${postId} / ${gameHash}`);
  const timeLimit = game.time_limit;

  // 本文の形（sc#A.2）。4 つの形のどれでもなければ 400
  const body = readTurnResult(input.body);
  if (!body) return { result: { ok: false, error: "invalid_request" } };

  // 遊んだ結果の述語（sc#A.2 の表の 3〜6 行目）。外れたら何も保存しない
  let played: { score: number; frames: number; inputs: unknown[] } | null = null;
  if (body.via === "guest") {
    const rejected = checkPlayed(body, timeLimit);
    if (rejected) return { result: { ok: false, error: "invalid_result", reason: rejected } };
    // checkPlayed を通ったので、score と frames は整数、inputs は配列
    played = {
      score: body.score as number,
      frames: body.frames as number,
      inputs: body.inputs as unknown[],
    };
    // 実時間はランの合計で見る。記録にある遊んだ結果とこの結果を合わせる
    let playedSec = playedSeconds(played.frames, speed);
    let count = 1;
    for (const row of log) {
      if (row.via !== "guest" || row.frames === null) continue;
      playedSec += playedSeconds(row.frames, Number(row.speed));
      count++;
    }
    const elapsedSec = (now.getTime() - run.startedAt.getTime()) / 1000;
    if (!serverRealtimeOk({ playedSec, count, elapsedSec })) {
      return { result: { ok: false, error: "invalid_result", reason: "realtime" } };
    }
  }

  const author = input.actor.userId !== null && input.actor.userId === game.user_id;
  const tally = played
    ? tallyOf({
        via: "guest",
        verdict: "provisional",
        speed,
        author,
        frames: played.frames,
        timeLimit,
      })
    : tallyOf({ via: body.via as "timeout" | "error" | "noload", speed, author });

  // 集計を書き換える結果は post_stats の行ロックで直列にする（同じゲームへの同時の受理で更新を失わない）
  if (tally) {
    await tx.execute(
      sql`insert into post_stats (post_id) values (${postId}) on conflict do nothing`,
    );
  }
  const [stat] = await tx.execute<{ scores: number[]; failures: number }>(
    tally
      ? sql`select scores, failures from post_stats where post_id = ${postId} for update`
      : sql`select scores, failures from post_stats where post_id = ${postId}`,
  );
  // post_stats.scores は昇順（dm#A.3）。並びが崩れていても順位がずれないよう、ここで並べ直す
  const dist = [...(stat?.scores ?? [])].sort((a, b) => a - b);
  // 校正状態は分布のロックの後に読む（校正の遷移は同じロックの中で起きる）
  let calibration = await calibrationOf(tx, postId);

  // 偏差値を出すのは、遊んだ結果で、新作扱いでない手番の、校正済みで分布が足りているゲームだけ。
  // それ以外の遊んだ結果は比。skip は偏差値も比も出さず、ミスにもならない（sc#A.2）
  const calibrated = !isNew && calibration === "calibrated" && dist.length >= CALIBRATION_MIN_PLAYS;
  const dev = played && calibrated ? deviation(played.score, dist) : null;
  const outcome = played
    ? outcomeOf({ via: "guest", score: played.score }, missBelow)
    : outcomeOf({ via: body.via as "timeout" | "error" | "noload" }, missBelow);

  if (tally) {
    // 1 主体 5 件の窓: この主体の、集計に入っている直近 5 件のうち最古が押し出される。
    // 窓は分布と失敗の数で共有する（sc#A.4）。集計に入らない結果は窓を進めない
    const [pushed] = await tx.execute<{ via: string; score: number | null }>(sql`
      select via, score from sessions
      where post_id = ${postId} and actor_id = ${input.actor.id} and state = 'submitted'
        and speed = 1 and author = false
        and (via in ('timeout', 'error')
          or (via = 'guest' and verdict in ('provisional', 'accepted')
            and frames >= ${DISTRIBUTION_MIN_FRAMES_RATIO}::numeric * time_limit))
      order by submitted_at desc, id desc
      offset ${DISTRIBUTION_WINDOW - 1} limit 1`);
    let scores = dist;
    let failures = stat?.failures ?? 0;
    if (pushed?.via === "guest" && pushed.score !== null) scores = without(scores, pushed.score);
    else if (pushed) failures = Math.max(0, failures - 1);
    if (tally === "distribution" && played) {
      scores = [...scores, played.score].sort((a, b) => a - b);
    } else {
      failures++;
    }
    await tx
      .update(postStats)
      .set({ n: scores.length, scores, failures, updatedAt: now })
      .where(eq(postStats.postId, postId));

    // 校正（sc#A.7）。未校正からだけ進む。invalid は終端で、校正済みはここでは変えない
    const decided = calibration === "uncalibrated" ? calibrationVerdict(scores, failures) : null;
    if (decided) {
      await tx.execute(
        sql`update posts set calibration = ${decided}::calibration where id = ${postId}`,
      );
      calibration = decided;
    }
    if (decided === "calibrated") {
      // limited は校正済みになる遷移で public に昇格する。制限中と upheld の通報がある投稿は昇格しない（mo#A.2）
      await tx.execute(sql`
        update posts set base_status = 'public'
        where id = ${postId} and base_status = 'limited'
          and exists (select 1 from post_status ps where ps.id = posts.id and ps.status = 'limited')
          and not exists (
            select 1 from reports r where r.post_id = posts.id and r.resolution = 'upheld')`);
    }
  }

  // 記録に足す（I7）。ランの手番は submitted の 1 行で、open で入ることはない（dm#A.3）
  const sessionId = ulid(now.getTime());
  await tx.insert(sessions).values({
    id: sessionId,
    postId,
    gameHash,
    actorId: input.actor.id,
    deviceKind: input.deviceKind,
    runId: run.id,
    turn: t,
    mode: "play",
    seed,
    speed: speed.toFixed(3),
    timeLimit,
    missBelow,
    isNew,
    author,
    state: "submitted",
    via: body.via,
    score: played?.score ?? null,
    frames: played?.frames ?? null,
    deviation: dev === null ? null : dev.toFixed(1),
    issuedAt: now,
    submittedAt: now,
  });
  const added: LogRow = {
    id: sessionId,
    turn: t,
    post_id: postId,
    via: body.via,
    score: played?.score ?? null,
    frames: played?.frames ?? null,
    speed: speed.toFixed(3),
    miss_below: missBelow,
    deviation: dev === null ? null : dev.toFixed(1),
    is_new: isNew,
    target: game.target,
  };
  const next = [...log, added];
  // 記録だけから閉じるラン（3 回目のミス、3 本目の読み込みの skip、次の手番が無い）は、ここで閉じて凍結する
  if (logState(run.mode, run.deck.length, next.map(outcomeOfRow)).ended !== null) {
    await freezeRun(tx, run, next, now);
  } else {
    await tx.update(runs).set({ settled: next.length }).where(eq(runs.id, run.id));
  }

  const value: SettledTurn = {
    settled: next.length,
    deviation: dev,
    miss: outcome === "miss",
    calibration,
    ratio: played && dev === null ? ratioOf(played.score, game.target) : null,
  };
  return {
    result: { ok: true, value },
    ...(played ? { replay: { sessionId, seed, speed, inputs: played.inputs } } : {}),
  };
}
