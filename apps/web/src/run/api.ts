// ラン API（run#A.3）の呼び出しと、応答の読み方。主体は `X-Device-Id`（#161 の 1）。
// 応答はサーバのものでも形を確かめてから使う（古いデプロイや途中のプロキシの応答で画面を壊さない）。
import type { InputLogEntry } from "@gamefeed/sdk";
import { DEVICE_ID_HEADER } from "./device-id.ts";

/** 計画の、山札の 1 位置（run#A.3） */
export interface PlanEntry {
  post_id: string;
  is_new: boolean;
  /** この点数未満ならミス。null（新作枠、校正中）はミスにならない */
  miss_below: number | null;
  /** 論理フレーム数。`init.time_limit` に入れる */
  time_limit: number;
}

/** 凍結した計画（`POST /runs` の応答） */
export interface RunPlan {
  runId: string;
  /** ランの seed。32 bit 符号なし */
  seed: number;
  deck: PlanEntry[];
}

/** 手番の結果の本文（sc#A.2 の 4 つの形） */
export type TurnBody =
  | { via: "guest"; score: number; frames: number; inputs: readonly InputLogEntry[] }
  | { via: "timeout" }
  | { via: "error" }
  | { via: "noload" };

/** `PUT /runs/{id}/turns/{t}` の応答を、Host が区別する 4 つに読んだもの */
export type TurnReply =
  | {
      kind: "settled";
      settled: number;
      /** 受理時の偏差値。校正中・新作扱い・skip は null */
      deviation: number | null;
      miss: boolean;
      /** 偏差値を出さない遊んだ結果の `min(1, score / target)` */
      ratio: number | null;
    }
  | { kind: "out_of_order"; settled: number }
  | { kind: "closed"; settled: number }
  /** 応答なし・ほかのステータス。送り直す */
  | { kind: "failed" };

export interface ReportTurn {
  turn: number;
  post_id: string;
  kind: "ok" | "miss" | "skip";
  deviation: number | null;
  ratio: number | null;
  is_new: boolean;
  speed: number;
}

/** 凍結した成績表（`finish` の応答。run#A.11）。Host は描くだけ */
export interface RunReport {
  run_id: string;
  mode: "endless" | "daily";
  ended: "lives" | "limit" | "abandoned" | "error";
  reached: number;
  avg_deviation: number | null;
  symbols: string | null;
  turns: ReportTurn[];
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isNumberOrNull = (x: unknown): x is number | null =>
  x === null || (typeof x === "number" && Number.isFinite(x));

export function readPlan(body: unknown): RunPlan | null {
  if (!isObject(body) || typeof body.run_id !== "string") return null;
  if (!isCount(body.seed) || body.seed > 0xffffffff) return null;
  if (!Array.isArray(body.deck) || body.deck.length === 0) return null;
  const deck: PlanEntry[] = [];
  for (const e of body.deck as unknown[]) {
    if (!isObject(e) || typeof e.post_id !== "string" || typeof e.is_new !== "boolean") return null;
    if (!isNumberOrNull(e.miss_below)) return null;
    if (!isCount(e.time_limit) || e.time_limit < 1) return null;
    deck.push({
      post_id: e.post_id,
      is_new: e.is_new,
      miss_below: e.miss_below,
      time_limit: e.time_limit,
    });
  }
  return { runId: body.run_id, seed: body.seed, deck };
}

export function readTurnReply(status: number, body: unknown): TurnReply {
  if (!isObject(body) || !isCount(body.settled)) return { kind: "failed" };
  const settled = body.settled;
  if (status === 200) {
    return {
      kind: "settled",
      settled,
      deviation: isNumberOrNull(body.deviation) ? body.deviation : null,
      miss: body.miss === true,
      ratio: isNumberOrNull(body.ratio) ? body.ratio : null,
    };
  }
  if (status === 409 && body.error === "out_of_order") return { kind: "out_of_order", settled };
  if (status === 409 && body.error === "run_closed") return { kind: "closed", settled };
  return { kind: "failed" };
}

const ENDED = ["lives", "limit", "abandoned", "error"] as const;
const KINDS = ["ok", "miss", "skip"] as const;

export function readReport(body: unknown): RunReport | null {
  if (!isObject(body) || typeof body.run_id !== "string") return null;
  if (body.mode !== "endless" && body.mode !== "daily") return null;
  const ended = ENDED.find((e) => e === body.ended);
  if (!ended || !isCount(body.reached) || !isNumberOrNull(body.avg_deviation)) return null;
  if (body.symbols !== null && typeof body.symbols !== "string") return null;
  if (!Array.isArray(body.turns)) return null;
  const turns: ReportTurn[] = [];
  for (const t of body.turns as unknown[]) {
    if (!isObject(t) || !isCount(t.turn) || typeof t.post_id !== "string") return null;
    const kind = KINDS.find((k) => k === t.kind);
    if (!kind || !isNumberOrNull(t.deviation) || !isNumberOrNull(t.ratio)) return null;
    if (typeof t.is_new !== "boolean" || typeof t.speed !== "number") return null;
    turns.push({
      turn: t.turn,
      post_id: t.post_id,
      kind,
      deviation: t.deviation,
      ratio: t.ratio,
      is_new: t.is_new,
      speed: t.speed,
    });
  }
  return {
    run_id: body.run_id,
    mode: body.mode,
    ended,
    reached: body.reached,
    avg_deviation: body.avg_deviation,
    symbols: body.symbols,
    turns,
  };
}

export type CreateRunResult =
  | { ok: true; plan: RunPlan }
  /** 出せるゲームが 0 本（409 `no_games`） */
  | { ok: false; error: "no_games" }
  /** 共有リンクのランが無い（404 `run_not_found`） */
  | { ok: false; error: "run_not_found" }
  | { ok: false; error: "failed"; status: number };

const jsonHeaders = (device: string): Record<string, string> => ({
  "content-type": "application/json",
  accept: "application/json",
  [DEVICE_ID_HEADER]: device,
});

/** エンドレスのランを作る。fromRun があれば、そのランの山札を写す（run#A.3） */
export async function createRun(device: string, fromRun: string | null): Promise<CreateRunResult> {
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: jsonHeaders(device),
    body: JSON.stringify(fromRun ? { mode: "endless", from_run: fromRun } : { mode: "endless" }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 201) {
    const plan = readPlan(body);
    return plan ? { ok: true, plan } : { ok: false, error: "failed", status: res.status };
  }
  const error = isObject(body) ? body.error : undefined;
  if (res.status === 409 && error === "no_games") return { ok: false, error: "no_games" };
  if (res.status === 404 && error === "run_not_found") return { ok: false, error: "run_not_found" };
  return { ok: false, error: "failed", status: res.status };
}

/** 手番 t の結果を送る。通信の失敗も `failed` として返す（例外にしない） */
export async function putTurn(
  device: string,
  runId: string,
  turn: number,
  body: TurnBody,
): Promise<TurnReply> {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/turns/${turn}`, {
      method: "PUT",
      headers: jsonHeaders(device),
      // keepalive は付けない。本文の上限（64 KiB）を超えると、ページが開いていても通信エラーになる。
      // 入力ログには大きさの上限が無いので、超えた手番は何度送り直しても記録に入らなくなる
      body: JSON.stringify(body),
    });
    return readTurnReply(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "failed" };
  }
}

/** ランを閉じて成績表を受け取る。何度呼んでも同じ（run#A.3）。取れなければ null */
export async function finishRun(device: string, runId: string): Promise<RunReport | null> {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/finish`, {
      method: "POST",
      headers: jsonHeaders(device),
      keepalive: true,
    });
    if (res.status !== 200) return null;
    return readReport(await res.json().catch(() => null));
  } catch {
    return null;
  }
}
