import { z } from "zod";
import { describeError, type AssetPaths, type TypeSafeGateway } from "../client.js";
import { lintQuestions } from "../lint.js";
import { errorResult, toolResult } from "../format.js";
import { assetsSchema, questionsSchema, stateSchema } from "../schemas.js";
import type { Questions } from "../types.js";

export const evaluateInput = {
  state: stateSchema,
  questions: questionsSchema,
  model: z.string().optional().describe("Model id or alias; defaults to TYPESAFE_DEFAULT_MODEL (jev-latest)"),
  assets: assetsSchema.optional(),
};

const EXPERIMENTAL = "[experimental] Images and Box questions are a TypeSafe Danger Zone feature: the request format, answers and limits can change between releases.";

/** Lint for a request; `assets` (references) turns on the image rules, so pass it only when the request's images are known. */
export function lintWarnings(questions: Questions, state: unknown, maxTokensPerCall: number, model: string, assets?: readonly string[]): { blocked: string[]; warnings: string[] } {
  const lint = lintQuestions(questions, state, maxTokensPerCall, [], assets === undefined ? { model } : { model, assets });
  const experimental = (assets !== undefined && assets.length > 0) || Object.values(questions).some((q) => q.type === "box");
  return {
    blocked: lint.errors.map((f) => `${f.question_id ? f.question_id + ": " : ""}${f.message}. ${f.fix}`),
    warnings: [...lint.warnings.map((f) => `${f.question_id ? f.question_id + ": " : ""}[${f.rule}] ${f.message}`), ...(experimental ? [EXPERIMENTAL] : [])],
  };
}

export function makeEvaluate(gateway: TypeSafeGateway, maxTokensPerCall: number) {
  return async (args: { state: unknown; questions: Questions; model?: string; assets?: AssetPaths }, extra?: { signal?: AbortSignal }) => {
    const { blocked, warnings } = lintWarnings(args.questions, args.state, maxTokensPerCall, args.model ?? gateway.defaultModel, Object.keys(args.assets ?? {}));
    if (blocked.length) return errorResult(`questions rejected by lint:\n- ${blocked.join("\n- ")}`);
    try {
      const result = await gateway.systemOne(args.state, args.questions, args.model, extra?.signal, args.assets);
      return toolResult({ ...result, warnings });
    } catch (err) {
      return errorResult(describeError(err));
    }
  };
}
