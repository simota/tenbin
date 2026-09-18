import { z } from "zod";
import { API_LIMITS } from "../config.js";
import { APIUserAbortError } from "@typesafe-ai/sdk";
import { CallTooLargeError, describeError, type TypeSafeGateway } from "../client.js";
import { errorResult, toolResult } from "../format.js";
import { pool } from "../pool.js";
import { entryType } from "../schemas.js";
import { estimateTokens } from "../tokens.js";
import type { EntryType, Questions } from "../types.js";

export const rankInput = {
  query: entryType.describe("What the candidates are judged against (placed in state.query)"),
  candidates: z.array(z.object({ id: z.string(), content: entryType })).min(1).describe("Items to rank; each becomes state.candidates[i]"),
  mode: z.enum(["noul", "choice"]).default("noul").describe("noul: one independent probability per candidate (default). choice: one Choice over candidate ids; probabilities sum to 1"),
  instructions: z.string().describe("Question text. Use the placeholder {candidate} where the candidate path goes, e.g. 'Does {candidate} answer `query`?'"),
  criteria: z.object({ true: entryType.optional(), false: entryType.optional() }).optional().describe("noul mode only: what yes / no mean"),
  existence_check: entryType.optional().describe("Optional Noul asked alongside, e.g. 'Does any candidate answer `query`?' (recommended in choice mode, since a Choice always names a winner)"),
  top_k: z.number().int().min(1).optional(),
  threshold: z.number().min(0).max(1).optional().describe("Drop candidates scoring below this"),
  concurrency: z.number().int().min(1).max(32).optional().describe("Parallel batch requests; defaults to TENBIN_CONCURRENCY"),
  model: z.string().optional(),
};

type Candidate = { id: string; content: EntryType };

export interface BatchLimits {
  /** Whole request: state + all questions. */
  totalTokens: number;
  /** API rule: state + the longest single question. */
  stateAndQuestionTokens: number;
  maxPerBatch: number;
  /** choice mode: every candidate adds to ONE question, so the longest question grows with the batch. */
  cumulativeQuestion: boolean;
}

export interface SharedTokens {
  /** State every batch carries (the query and envelope). */
  state: number;
  /** Questions every batch carries in full (existence_check, the choice question's instructions). */
  questions: number;
  /** The largest shared question that does NOT grow with the batch (existence_check). */
  longestQuestion: number;
  /** Base size of the one question that grows with every candidate (choice mode), else 0. */
  choiceQuestion: number;
}

/**
 * Split candidates so every batch respects both token limits and the Choice option cap.
 * State and question tokens are tracked separately so the 32k "state + longest question" rule
 * counts each shared question once. `perCandidate(c)` is what one candidate adds to each side.
 */
export function batchCandidates(candidates: Candidate[], shared: SharedTokens, perCandidate: (c: Candidate) => { state: number; questions: number }, limits: BatchLimits): Candidate[][] {
  const batches: Candidate[][] = [];
  let cur: Candidate[] = [];
  let stateTokens = shared.state;
  let questionTokens = shared.questions;
  for (const c of candidates) {
    const t = perCandidate(c);
    const longestQuestion = limits.cumulativeQuestion
      ? Math.max(shared.longestQuestion, shared.choiceQuestion + (questionTokens - shared.questions) + t.questions)
      : Math.max(shared.longestQuestion, t.questions);
    const fits =
      cur.length < limits.maxPerBatch &&
      stateTokens + t.state + longestQuestion <= limits.stateAndQuestionTokens &&
      stateTokens + t.state + questionTokens + t.questions <= limits.totalTokens;
    if (cur.length > 0 && !fits) {
      batches.push(cur);
      cur = [];
      stateTokens = shared.state;
      questionTokens = shared.questions;
    }
    cur.push(c);
    stateTokens += t.state;
    questionTokens += t.questions;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** The option a batch put the most probability on. */
export function batchWinner<T extends { id: string }>(batch: T[], probabilities: Map<string, number>): T {
  return batch.reduce((best, c) => ((probabilities.get(c.id) ?? 0) > (probabilities.get(best.id) ?? 0) ? c : best));
}

/**
 * Merge per-batch Choice results with a final round over the batch winners.
 * Each candidate is scaled relative to its batch winner (so within-batch order holds), the winner
 * takes its final-round probability (so the final round's order holds), and the whole set is
 * normalised to sum to 1.
 */
export function combineRounds<T extends { id: string }>(batches: T[][], perBatch: Map<string, number>[], winners: T[], finalRound: Map<string, number>): Map<string, number> {
  const raw = new Map<string, number>();
  batches.forEach((b, i) => {
    const pWinnerFinal = finalRound.get(winners[i].id) ?? 0;
    const pWinnerInBatch = perBatch[i].get(winners[i].id) ?? 0;
    for (const c of b) raw.set(c.id, pWinnerInBatch > 0 ? pWinnerFinal * ((perBatch[i].get(c.id) ?? 0) / pWinnerInBatch) : 0);
  });
  let total = 0;
  for (const v of raw.values()) total += v;
  const out = new Map<string, number>();
  for (const [id, v] of raw) out.set(id, total > 0 ? v / total : 0);
  return out;
}

export function makeRank(gateway: TypeSafeGateway, maxTokensPerCall: number, concurrency: number) {
  return async (
    args: {
      query: EntryType; candidates: Candidate[]; mode: "noul" | "choice"; instructions: string;
      criteria?: { true?: EntryType; false?: EntryType }; existence_check?: EntryType; top_k?: number; threshold?: number; concurrency?: number; model?: string;
    },
    extra?: { signal?: AbortSignal },
  ) => {
    if (!args.instructions.includes("{candidate}")) return errorResult("instructions must contain the {candidate} placeholder");
    const ids = new Set(args.candidates.map((c) => c.id));
    if (ids.size !== args.candidates.length) return errorResult("candidate ids must be unique");

    const noulQuestion = (i: number): Questions[string] => ({ type: "noul", instructions: args.instructions.replaceAll("{candidate}", `\`candidates[${i}]\``), ...(args.criteria ? { criteria: args.criteria } : {}) });
    const choiceInstructions = args.instructions.replaceAll("{candidate}", "the best of `candidates`");
    const existsQuestion: Questions[string] | undefined = args.existence_check !== undefined ? { type: "noul", instructions: args.existence_check } : undefined;

    // Estimate exactly what runBatch will send: shared parts once, per-candidate parts per candidate.
    const existsTokens = existsQuestion ? estimateTokens(existsQuestion) : 0;
    const choiceTokens = args.mode === "choice" ? estimateTokens({ type: "choice", instructions: choiceInstructions, criteria: {} }) : 0;
    const shared: SharedTokens = {
      state: estimateTokens({ query: args.query, candidates: [] }),
      questions: existsTokens + choiceTokens,
      longestQuestion: existsTokens,
      choiceQuestion: choiceTokens,
    };
    const perCandidate = (c: Candidate) => ({
      state: estimateTokens(c.content) + 1,
      questions: args.mode === "noul" ? estimateTokens(noulQuestion(999)) + 2 : estimateTokens(c.id) + 6,
    });
    const limits: BatchLimits = {
      totalTokens: maxTokensPerCall * 0.9,
      stateAndQuestionTokens: API_LIMITS.stateAndLongestQuestionTokens * 0.9,
      maxPerBatch: API_LIMITS.maxChoiceOptions,
      cumulativeQuestion: args.mode === "choice",
    };
    const split = (cands: Candidate[]) => batchCandidates(cands, shared, perCandidate, limits);

    let exists: number | undefined;
    let calls = 0;
    let costUsd = 0;

    /** Runs one batch and returns the score it assigned to each candidate id. */
    const runBatch = async (batch: Candidate[]): Promise<Map<string, number>> => {
      const state = { query: args.query, candidates: batch.map((c) => c.content) };
      const questions: Questions = {};
      if (args.mode === "noul") {
        batch.forEach((_c, i) => { questions[`c_${i}`] = noulQuestion(i); });
      } else {
        const criteria: Record<string, EntryType> = Object.create(null);
        batch.forEach((c, i) => { criteria[c.id] = `\`candidates[${i}]\``; });
        questions.pick = { type: "choice", instructions: choiceInstructions, criteria };
      }
      if (existsQuestion) questions.exists = existsQuestion;
      const r = await gateway.systemOne(state, questions, args.model, extra?.signal);
      calls += 1;
      costUsd += r.cost_usd;
      const out = new Map<string, number>();
      if (args.mode === "noul") {
        batch.forEach((c, i) => { const a = r.answers[`c_${i}`]; if (a?.type === "noul") out.set(c.id, a.noul); });
      } else {
        const a = r.answers.pick;
        if (a?.type === "choice") for (const [id, p] of Object.entries(a.probabilities)) out.set(id, p);
      }
      const e = r.answers.exists;
      if (e?.type === "noul") exists = exists === undefined ? e.noul : Math.max(exists, e.noul);
      return out;
    };

    /**
     * Choice mode over more candidates than one request holds: each batch yields P(c | batch); the
     * batch winners compete in a further round (recursively split the same way). combineRounds
     * merges the two so that winners keep their final-round order, losers stay below their own
     * winner, and everything sums to 1.
     */
    const rankChoice = async (cands: Candidate[]): Promise<Map<string, number>> => {
      const batches = split(cands);
      if (batches.length === 1) return runBatch(batches[0]);
      if (batches.length === cands.length) {
        // Splitting made no progress: the safety-margin batcher put every candidate alone. The set
        // may still fit the real API limits, so let the gateway decide on the actual request.
        if (cands.length > API_LIMITS.maxChoiceOptions) throw new CallTooLargeError(`${cands.length} candidates each need a request of their own and cannot be compared in one Choice (max ${API_LIMITS.maxChoiceOptions} options); shrink candidate content`);
        return runBatch(cands);
      }
      const perBatch = await pool(batches, args.concurrency ?? concurrency, runBatch, extra?.signal);
      if (extra?.signal?.aborted) throw new APIUserAbortError();
      const winners = batches.map((b, i) => batchWinner(b, perBatch[i]));
      const finalRound = await rankChoice(winners);
      return combineRounds(batches, perBatch, winners, finalRound);
    };

    let scores = new Map<string, number>();
    const batchCount = split(args.candidates).length;
    try {
      if (args.mode === "noul") {
        const results = await pool(split(args.candidates), args.concurrency ?? concurrency, runBatch, extra?.signal);
        if (extra?.signal?.aborted) return errorResult("cancelled before all batches ran");
        for (const m of results) for (const [id, p] of m) scores.set(id, p);
      } else {
        scores = await rankChoice(args.candidates);
      }
    } catch (err) {
      return errorResult(describeError(err));
    }

    let ranked = args.candidates
      .map((c) => ({ id: c.id, score: scores.get(c.id) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    if (args.threshold !== undefined) ranked = ranked.filter((r) => r.score >= args.threshold!);
    if (args.top_k !== undefined) ranked = ranked.slice(0, args.top_k);

    const structured = { ranked, exists, mode: args.mode, batches: batchCount, calls, cost_usd: costUsd };
    return toolResult(structured);
  };
}
