import { describeError, type TypeSafeGateway } from "../client.js";
import { errorResult, toolResult } from "../format.js";
import { lintQuestions } from "../lint.js";
import { questionsSchema, stateSchema } from "../schemas.js";
import { PRICE_PER_MTOK_USD } from "../config.js";
import type { Questions } from "../types.js";

export const lintInput = {
  questions: questionsSchema,
  state: stateSchema.optional().describe("If given, backticked paths in instructions are checked against it and the token budget is estimated"),
};

export function makeLint(maxTokensPerCall: number) {
  return async (args: { questions: Questions; state?: unknown }) => {
    const r = lintQuestions(args.questions, args.state, maxTokensPerCall);
    return toolResult({ ...r, ok: r.errors.length === 0 });
  };
}

export const PRICING = { "jev-1.13.0": { usd_per_mtok_input: PRICE_PER_MTOK_USD, usd_per_btok_input: PRICE_PER_MTOK_USD * 1000, output_tokens: "free", rate_limit: "250,000 tokens/s, 1,200 requests/min (dynamic)" } };

export function makeListModels(gateway: TypeSafeGateway) {
  return async () => {
    try {
      const models = await gateway.listModels();
      const structured = { models, default_model: gateway.defaultModel, pricing: PRICING, note: "Aliases move on new releases; pin a versioned id if you tuned thresholds against it." };
      return toolResult(structured);
    } catch (err) {
      return errorResult(describeError(err));
    }
  };
}

export function makeSessionStats(gateway: TypeSafeGateway) {
  return async () => {
    const s = gateway.stats();
    return toolResult({ ...s });
  };
}

export const noArgs = {};
