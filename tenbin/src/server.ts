import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TypeSafeGateway } from "./client.js";
import type { Config } from "./config.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { evaluateInput, makeEvaluate } from "./tools/evaluate.js";
import { evaluateManyInput, makeEvaluateMany } from "./tools/evaluate_many.js";
import { lintInput, makeLint, makeListModels, makeSessionStats, noArgs } from "./tools/misc.js";
import { makeRank, rankInput } from "./tools/rank.js";
import { makeWalkTaxonomy, walkTaxonomyInput } from "./tools/walk_taxonomy.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function createServer(config: Config, gateway: TypeSafeGateway | null): McpServer {
  const server = new McpServer({ name: "tenbin", version: "0.1.0" });

  server.registerTool("tenbin_lint_questions", {
    title: "Lint TypeSafe questions (offline)",
    description: "Static checks on a questions map without calling the API: level/option counts, numeric-only or degree-only levels, compound or counting/date instructions, inverted Noul criteria, missing state paths, token budget. Run before tenbin_evaluate.",
    inputSchema: lintInput,
    annotations: LOCAL,
  }, makeLint(config.maxTokensPerCall));

  if (!gateway) return server;

  server.registerTool("tenbin_evaluate", {
    title: "Evaluate one state with many questions",
    description: "POST /v1/systemone: evaluate a state against a map of Choice/Score/Noul questions in one call. Put every question that uses this state here, including speculative ones. Questions are linted first; errors block, warnings are returned alongside answers. Returns answers, usage, cost_usd, request_id, latency_ms.",
    inputSchema: evaluateInput,
    annotations: READ_ONLY,
  }, makeEvaluate(gateway, config.maxTokensPerCall));

  server.registerTool("tenbin_evaluate_many", {
    title: "Evaluate many states with the same questions",
    description: "Runs tenbin_evaluate over a list of states concurrently (map-reduce, feature extraction, threshold calibration). repeat>1 measures self-consistency. Returns per-row answers, per-question statistics (mean/std, choice histogram, confidence), and failures.",
    inputSchema: evaluateManyInput,
    annotations: READ_ONLY,
  }, makeEvaluateMany(gateway, config.maxTokensPerCall, config.concurrency, config.maxStates));

  server.registerTool("tenbin_rank", {
    title: "Rank candidates against a query",
    description: "Scores each candidate against a query (rerank, semantic find, dedupe). noul mode asks one independent Noul per candidate in a fan-out; choice mode asks one Choice over candidate ids. Batches automatically when candidates exceed the token budget or the 255-option cap. Optional existence_check Noul says whether any candidate fits.",
    inputSchema: rankInput,
    annotations: READ_ONLY,
  }, makeRank(gateway, config.maxTokensPerCall, config.concurrency));

  server.registerTool("tenbin_walk_taxonomy", {
    title: "Classify into a nested taxonomy (beam search)",
    description: "Walks a nested tree level by level, asking a Choice whose option descriptions are the subtrees and keeping the top beam_width paths by geometric-mean edge probability. Levels with more than 255 options or oversized descriptions are split into chunks whose winners meet in a final round; beam paths share requests where the limits allow.",
    inputSchema: walkTaxonomyInput,
    annotations: READ_ONLY,
  }, makeWalkTaxonomy(gateway, config.maxTokensPerCall, config.concurrency));

  server.registerTool("tenbin_list_models", {
    title: "List models, aliases and pricing",
    description: "GET /v1/models plus the current pricing table and the server's default model.",
    inputSchema: noArgs,
    annotations: READ_ONLY,
  }, makeListModels(gateway));

  server.registerTool("tenbin_session_stats", {
    title: "Session usage and remaining budget",
    description: "Calls, failures, tokens, cost in USD, and remaining session token budget for this server process.",
    inputSchema: noArgs,
    annotations: LOCAL,
  }, makeSessionStats(gateway));

  registerResources(server);
  registerPrompts(server);
  return server;
}
