import { z } from "zod";
import { describeError, type TypeSafeGateway } from "../client.js";
import { lintQuestions } from "../lint.js";
import { errorResult, toolResult } from "../format.js";
import { questionsSchema, stateSchema } from "../schemas.js";
import type { Questions } from "../types.js";

export const evaluateInput = {
  state: stateSchema,
  questions: questionsSchema,
  model: z.string().optional().describe("Model id or alias; defaults to TYPESAFE_DEFAULT_MODEL (jev-latest)"),
};

export function lintWarnings(questions: Questions, state: unknown, maxTokensPerCall: number): { blocked: string[]; warnings: string[] } {
  const lint = lintQuestions(questions, state, maxTokensPerCall);
  return {
    blocked: lint.errors.map((f) => `${f.question_id ? f.question_id + ": " : ""}${f.message}. ${f.fix}`),
    warnings: lint.warnings.map((f) => `${f.question_id ? f.question_id + ": " : ""}[${f.rule}] ${f.message}`),
  };
}

export function makeEvaluate(gateway: TypeSafeGateway, maxTokensPerCall: number) {
  return async (args: { state: unknown; questions: Questions; model?: string }, extra?: { signal?: AbortSignal }) => {
    const { blocked, warnings } = lintWarnings(args.questions, args.state, maxTokensPerCall);
    if (blocked.length) return errorResult(`questions rejected by lint:\n- ${blocked.join("\n- ")}`);
    try {
      const result = await gateway.systemOne(args.state, args.questions, args.model, extra?.signal);
      return toolResult({ ...result, warnings });
    } catch (err) {
      return errorResult(describeError(err));
    }
  };
}
