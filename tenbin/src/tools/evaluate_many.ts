import { z } from "zod";
import { describeError, isBatchWideError, isCancellation, type AssetPaths, type TypeSafeGateway } from "../client.js";
import { errorResult, toolResult } from "../format.js";
import { lintAssets } from "../lint.js";
import { assetsSchema, questionsSchema, stateSchema } from "../schemas.js";
import type { Answer, Questions } from "../types.js";
import { pool } from "../pool.js";
import { lintWarnings } from "./evaluate.js";

export const evaluateManyInput = {
  states: z.array(z.object({ id: z.string(), state: stateSchema, assets: assetsSchema.optional().describe("This row's images, merged with the shared assets") })).min(1).describe("States to evaluate with the same questions"),
  questions: questionsSchema,
  model: z.string().optional(),
  assets: assetsSchema.optional().describe("Images shared by every row, e.g. example pictures in criteria; each row also gets its own states[].assets"),
  repeat: z.number().int().min(1).max(50).default(1).describe(">1 re-evaluates each state with a distinct sample_uid to measure self-consistency. Object states get a sample_uid field added; string/array states are wrapped as {content, sample_uid}, so backticked paths must start with content."),
  concurrency: z.number().int().min(1).max(32).optional(),
};

interface Row {
  id: string;
  sample: number;
  answers?: Record<string, Answer>;
  request_id?: string;
  error?: string;
  cancelled?: true;
}

function stats(values: number[]) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, std: null, min: null, max: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean: round(mean), std: round(std), min: round(Math.min(...values)), max: round(Math.max(...values)) };
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

export function summarize(rows: Row[], questions: Questions) {
  const per: Record<string, unknown> = Object.create(null);
  for (const [qid, q] of Object.entries(questions)) {
    const answers = rows.flatMap((r) => (r.answers?.[qid] ? [r.answers[qid]] : []));
    if (q.type === "noul") {
      per[qid] = { type: "noul", noul: stats(answers.map((a) => (a.type === "noul" ? a.noul : NaN)).filter(Number.isFinite)) };
    } else if (q.type === "choice") {
      const hist: Record<string, number> = Object.create(null);
      const conf: number[] = [];
      for (const a of answers) if (a.type === "choice") { hist[a.choice] = (hist[a.choice] ?? 0) + 1; conf.push(a.confidence); }
      per[qid] = { type: "choice", choice_histogram: hist, confidence: stats(conf) };
    } else if (q.type === "box") {
      const edges = { top: [] as number[], bottom: [] as number[], left: [] as number[], right: [] as number[] };
      const conf: number[] = [];
      for (const a of answers) {
        if (a.type !== "box") continue;
        for (const edge of ["top", "bottom", "left", "right"] as const) edges[edge].push(a.box[edge]);
        if (a.confidence !== null) conf.push(a.confidence);
      }
      per[qid] = { type: "box", top: stats(edges.top), bottom: stats(edges.bottom), left: stats(edges.left), right: stats(edges.right), confidence: stats(conf) };
    } else {
      const score: number[] = [];
      const conf: number[] = [];
      for (const a of answers) if (a.type === "score") { score.push(a.score); conf.push(a.confidence); }
      per[qid] = { type: "score", score: stats(score), confidence: stats(conf) };
    }
  }
  return per;
}

/** A distinct uid per sample so repeated evaluations are independent trials, without moving the state's own paths. */
export function withSampleUid(state: unknown, uid: string): unknown {
  if (state && typeof state === "object" && !Array.isArray(state)) return { ...(state as Record<string, unknown>), sample_uid: uid };
  return { content: state, sample_uid: uid };
}

export function makeEvaluateMany(gateway: TypeSafeGateway, maxTokensPerCall: number, defaultConcurrency: number, maxStates: number) {
  return async (args: { states: { id: string; state: unknown; assets?: AssetPaths }[]; questions: Questions; model?: string; assets?: AssetPaths; repeat: number; concurrency?: number }, extra?: { signal?: AbortSignal }) => {
    if (args.states.length > maxStates) return errorResult(`${args.states.length} states exceeds TENBIN_MAX_STATES (${maxStates}). Split into several calls.`);
    const shared = args.assets ?? {};
    const clashes = args.states.flatMap((s) => Object.keys(s.assets ?? {}).filter((ref) => ref in shared).map((ref) => `${s.id}: ${ref}`));
    if (clashes.length) return errorResult(`asset references defined both in assets and in states[].assets: ${clashes.join(", ")}. Give each image one reference.`);
    const rowAssets = (s: { assets?: AssetPaths }): AssetPaths => ({ ...shared, ...s.assets });
    const imageRefs = [...new Set([...Object.keys(shared), ...args.states.flatMap((s) => Object.keys(s.assets ?? {}))])];
    const prepare = (state: unknown, id: string, k: number) => (args.repeat > 1 ? withSampleUid(state, `${id}-${k}`) : state);
    // Shared questions are validated once, without a state, so a single oversized state cannot
    // block the batch: per-state size limits are enforced by the gateway and land in that row's error.
    const model = args.model ?? gateway.defaultModel;
    const { blocked } = lintWarnings(args.questions, undefined, maxTokensPerCall, model);
    if (blocked.length) return errorResult(`questions rejected by lint:\n- ${blocked.join("\n- ")}`);
    const largest = args.states.reduce((a, b) => (JSON.stringify(a.state).length >= JSON.stringify(b.state).length ? a : b));
    const { warnings } = lintWarnings(args.questions, prepare(largest.state, largest.id, 0), maxTokensPerCall, model, imageRefs);

    const jobs = args.states.flatMap((s) => Array.from({ length: args.repeat }, (_, k) => ({ id: s.id, sample: k, state: prepare(s.state, s.id, k), assets: rowAssets(s) })));
    const started = Date.now();
    // A failure that would hit every row (bad key, no permission) stops scheduling; a failure that
    // depends on the row (too large, over budget, 422) stays in that row.
    const stop = new AbortController();
    let stoppedReason: string | undefined;
    extra?.signal?.addEventListener("abort", () => stop.abort(), { once: true });
    if (extra?.signal?.aborted) stop.abort();
    const rows: Row[] = await pool(jobs, args.concurrency ?? defaultConcurrency, async (job) => {
      // Image rules depend on the row (its own images and where its state references them), so a
      // row that breaks them fails alone, without an API call.
      const assetErrors = lintAssets(args.questions, job.state, Object.keys(job.assets)).filter((f) => f.severity === "error");
      if (assetErrors.length) return { id: job.id, sample: job.sample, error: `questions rejected by lint: ${assetErrors.map((f) => `${f.message}. ${f.fix}`).join(" ")}` };
      try {
        const r = await gateway.systemOne(job.state, args.questions, args.model, stop.signal, job.assets);
        return { id: job.id, sample: job.sample, answers: r.answers, request_id: r.request_id };
      } catch (err) {
        if (isCancellation(err)) return { id: job.id, sample: job.sample, cancelled: true as const };
        if (isBatchWideError(err) && !stoppedReason) { stoppedReason = describeError(err); stop.abort(); }
        return { id: job.id, sample: job.sample, error: describeError(err) };
      }
    }, stop.signal);
    const after = gateway.stats();
    const done = rows.filter((r) => r && !r.cancelled);
    const notRun = jobs.length - done.length;
    const cancelled = stoppedReason ? 0 : notRun;
    const skipped = stoppedReason ? notRun : 0;
    const structured = {
      rows: done,
      summary: {
        states: args.states.length,
        repeat: args.repeat,
        cancelled,
        skipped,
        stopped_reason: stoppedReason,
        per_question: summarize(done, args.questions),
        failures: done.filter((r) => r.error).map((r) => ({ id: r.id, sample: r.sample, error: r.error })),
        elapsed_ms: Date.now() - started,
        session_cost_usd_after: after.cost_usd,
      },
      warnings,
    };
    return toolResult(structured);
  };
}
