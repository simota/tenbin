import { z } from "zod";
import { API_LIMITS } from "../config.js";
import { CallTooLargeError, describeError, type TypeSafeGateway } from "../client.js";
import { errorResult, toolResult } from "../format.js";
import { pool } from "../pool.js";
import { stateSchema } from "../schemas.js";
import { estimateTokens } from "../tokens.js";
import type { EntryType, Question, Questions } from "../types.js";
import { batchWinner, combineRounds } from "./rank.js";

export const walkTaxonomyInput = {
  state: stateSchema,
  taxonomy: z.record(z.string(), z.unknown()).describe("Nested tree: {branch: {sub: [leaf, ...]} | [leaf, ...] | null}"),
  instructions: z.string().default("Which option does the state belong to?").describe("Asked at every level; the current path is appended"),
  beam_width: z.number().int().min(1).max(10).default(3),
  max_depth: z.number().int().min(1).max(20).default(10),
  subtree_token_limit: z.number().int().min(50).default(400).describe("Subtrees larger than this are trimmed to their children plus a sample of leaves"),
  model: z.string().optional(),
};

function children(node: unknown): string[] | null {
  if (node && typeof node === "object" && !Array.isArray(node)) return Object.keys(node as object);
  if (Array.isArray(node)) return node.map(String);
  return null;
}

/** Leaf labels: array items, `{label: null}` keys, and bare strings. */
function leavesOf(node: unknown, limit: number, out: string[] = []): string[] {
  if (out.length >= limit) return out;
  if (Array.isArray(node)) for (const l of node) { if (out.length >= limit) break; out.push(String(l)); }
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (out.length >= limit) break;
      if (v === null || v === undefined) out.push(k);
      else leavesOf(v, limit, out);
    }
  } else if (typeof node === "string") out.push(node);
  return out;
}

/**
 * Option description = the subtree, trimmed when it would blow the token budget. The trimmed
 * form (children + sample leaves) is shrunk until it fits too, since long labels can exceed the
 * limit even at small counts; the floor is just the counts.
 */
export function describeSubtree(node: unknown, tokenLimit: number): EntryType {
  if (node === null || node === undefined) return null;
  if (estimateTokens(node) <= tokenLimit) return node as EntryType;
  const kids = children(node) ?? [];
  const leaves = leavesOf(node, 20);
  for (let nKids = 50, nLeaves = 20; nKids > 0 || nLeaves > 0; nKids = Math.floor(nKids / 2), nLeaves = Math.floor(nLeaves / 2)) {
    const trimmed = { children: kids.slice(0, nKids), sample_leaves: leaves.slice(0, nLeaves) };
    if (estimateTokens(trimmed) <= tokenLimit) return trimmed;
  }
  return { children_count: kids.length, leaf_count: leavesOf(node, Number.MAX_SAFE_INTEGER).length };
}

/** `edge_probabilities` holds one entry per *decision*; a level with a single child is taken without a call and adds no edge (as the hierarchical classification cookbook's `is_decision`). */
export interface Path { path: string[]; node: unknown; edge_probabilities: number[] }

/** Geometric mean of the decision edges; any zero edge makes the path impossible, so 0. No decisions = the only possible path, so 1. */
export function pathScore(p: Path): number {
  if (p.edge_probabilities.length === 0) return 1;
  if (p.edge_probabilities.some((x) => x <= 0)) return 0;
  const logSum = p.edge_probabilities.reduce((a, b) => a + Math.log(b), 0);
  return Math.exp(logSum / p.edge_probabilities.length);
}

interface Opt { id: string; description: EntryType }

/** Split one level's options so each Choice stays under the option cap and the token budget. */
export function chunkOptions(opts: Opt[], maxPerChunk: number, tokenBudget: number): Opt[][] {
  const chunks: Opt[][] = [];
  let cur: Opt[] = [];
  let tokens = 0;
  for (const o of opts) {
    const t = estimateTokens(o.id) + estimateTokens(o.description) + 2;
    if (cur.length > 0 && (cur.length >= maxPerChunk || tokens + t > tokenBudget)) {
      chunks.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(o);
    tokens += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

interface Planned { key: string; question: Question; tokens: number }

/** Greedy grouping of questions into requests that respect both API limits for the given state. */
export function groupIntoRequests(items: Planned[], stateTokens: number, totalLimit: number, stateAndQuestionLimit: number): Planned[][] {
  const groups: Planned[][] = [];
  let cur: Planned[] = [];
  let total = stateTokens;
  let longest = 0;
  for (const it of items) {
    const fits = total + it.tokens <= totalLimit && stateTokens + Math.max(longest, it.tokens) <= stateAndQuestionLimit;
    if (cur.length > 0 && !fits) {
      groups.push(cur);
      cur = [];
      total = stateTokens;
      longest = 0;
    }
    cur.push(it);
    total += it.tokens;
    longest = Math.max(longest, it.tokens);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function makeWalkTaxonomy(gateway: TypeSafeGateway, maxTokensPerCall: number, concurrency: number) {
  return async (args: { state: unknown; taxonomy: Record<string, unknown>; instructions: string; beam_width: number; max_depth: number; subtree_token_limit: number; model?: string }, extra?: { signal?: AbortSignal }) => {
    let beam: Path[] = [{ path: [], node: args.taxonomy, edge_probabilities: [] }];
    const finished: Path[] = [];
    let calls = 0;
    let costUsd = 0;
    const stateTokens = estimateTokens(args.state);
    const totalLimit = maxTokensPerCall * 0.9;
    const stateAndQuestionLimit = API_LIMITS.stateAndLongestQuestionTokens * 0.9;
    const questionBudget = Math.min(totalLimit, stateAndQuestionLimit) - stateTokens;
    if (questionBudget < 200) return errorResult(`state is ~${stateTokens} tokens, leaving no room for a taxonomy question under the ${Math.round(stateAndQuestionLimit)} token limit. Trim the state.`);

    const optionsOf = (p: Path): Opt[] => {
      const kids = children(p.node) ?? [];
      const isArray = Array.isArray(p.node);
      return kids.map((k) => ({ id: k, description: isArray ? null : describeSubtree((p.node as Record<string, unknown>)[k], args.subtree_token_limit) }));
    };
    const questionFor = (p: Path, chunk: Opt[]): Question => {
      const criteria: Record<string, EntryType> = Object.create(null);
      for (const o of chunk) criteria[o.id] = o.description;
      return { type: "choice", instructions: p.path.length ? `${args.instructions} Current path: ${p.path.join(" > ")}.` : args.instructions, criteria };
    };

    /**
     * One level for every active path: options that exceed one Choice are chunked, the chunk
     * winners meet in further rounds, and all questions of a round across all paths share as few
     * requests as the limits allow. Returns option -> probability per path.
     */
    const decideLevel = async (active: Path[]): Promise<{ probs: Map<string, number>; forced: boolean }[]> => {
      interface Work { idx: number; opts: Opt[]; frames: { chunks: Opt[][]; perBatch: Map<string, number>[] }[] }
      const results = new Map<number, Map<string, number>>();
      const forced = new Set<number>();
      let work: Work[] = [];
      active.forEach((p, idx) => {
        const opts = optionsOf(p);
        // A single child is not a decision: take it without a call and without an edge.
        if (opts.length === 1) { results.set(idx, new Map([[opts[0].id, 1]])); forced.add(idx); return; }
        work.push({ idx, opts, frames: [] });
      });
      while (work.length) {
        const planned = work.map((w) => {
          // The instructions and current path travel with every chunk, so they come off the budget first.
          const fixed = estimateTokens(questionFor(active[w.idx], []));
          let chunks = chunkOptions(w.opts, API_LIMITS.maxChoiceOptions, questionBudget - fixed);
          if (chunks.length === w.opts.length && w.opts.length > 1) {
            // The margin-based chunker made no progress. Within the option cap the whole set may still
            // fit the real limits, so send it as one Choice and let the gateway decide.
            if (w.opts.length > API_LIMITS.maxChoiceOptions) {
              throw new CallTooLargeError(`taxonomy options under "${active[w.idx].path.join(" > ") || "root"}" are too large to compare even one per request; lower subtree_token_limit or shorten labels`);
            }
            chunks = [w.opts];
          }
          return { w, chunks };
        });
        const items = planned.flatMap(({ w, chunks }) => chunks.map((chunk, j) => {
          const question = questionFor(active[w.idx], chunk);
          return { key: `p${w.idx}_r${w.frames.length}_c${j}`, question, tokens: estimateTokens(question) };
        }));
        const answered = new Map<string, Map<string, number>>();
        await pool(groupIntoRequests(items, stateTokens, totalLimit, stateAndQuestionLimit), concurrency, async (group) => {
          const questions: Questions = {};
          for (const it of group) questions[it.key] = it.question;
          const r = await gateway.systemOne(args.state, questions, args.model, extra?.signal);
          calls += 1;
          costUsd += r.cost_usd;
          for (const it of group) {
            const a = r.answers[it.key];
            answered.set(it.key, a?.type === "choice" ? new Map(Object.entries(a.probabilities)) : new Map());
          }
        }, extra?.signal);
        if (extra?.signal?.aborted) throw new Error("cancelled");
        const next: Work[] = [];
        for (const { w, chunks } of planned) {
          const perBatch = chunks.map((_c, j) => answered.get(`p${w.idx}_r${w.frames.length}_c${j}`) ?? new Map<string, number>());
          if (chunks.length === 1) {
            let map = perBatch[0];
            for (let f = w.frames.length - 1; f >= 0; f--) {
              const fr = w.frames[f];
              map = combineRounds(fr.chunks, fr.perBatch, fr.chunks.map((c, j) => batchWinner(c, fr.perBatch[j])), map);
            }
            results.set(w.idx, map);
          } else {
            next.push({ idx: w.idx, opts: chunks.map((c, j) => batchWinner(c, perBatch[j])), frames: [...w.frames, { chunks, perBatch }] });
          }
        }
        work = next;
      }
      return active.map((_p, idx) => ({ probs: results.get(idx) ?? new Map<string, number>(), forced: forced.has(idx) }));
    };

    try {
      for (let depth = 0; depth < args.max_depth && beam.length; depth++) {
        const active: Path[] = [];
        for (const p of beam) {
          const kids = children(p.node);
          if (!kids || kids.length === 0) { finished.push(p); continue; }
          active.push(p);
        }
        beam = active;
        if (!active.length) break;
        const decided = await decideLevel(active);
        const expanded: Path[] = [];
        active.forEach((p, i) => {
          for (const [opt, prob] of decided[i].probs) {
            if (prob <= 0) continue;
            const child = Array.isArray(p.node) ? opt : (p.node as Record<string, unknown>)[opt];
            expanded.push({ path: [...p.path, opt], node: Array.isArray(p.node) ? null : child, edge_probabilities: decided[i].forced ? p.edge_probabilities : [...p.edge_probabilities, prob] });
          }
        });
        beam = expanded.sort((x, y) => pathScore(y) - pathScore(x)).slice(0, args.beam_width);
      }
    } catch (err) {
      return errorResult(describeError(err));
    }
    const all = [...finished, ...beam].map((p) => ({ path: p.path, score: Math.round(pathScore(p) * 10_000) / 10_000, edge_probabilities: p.edge_probabilities.map((x) => Math.round(x * 10_000) / 10_000), complete: children(p.node) === null || (children(p.node)?.length ?? 0) === 0 }))
      .sort((x, y) => y.score - x.score)
      .slice(0, args.beam_width);
    const structured = { paths: all, decisions: calls, cost_usd: costUsd };
    return toolResult(structured);
  };
}
