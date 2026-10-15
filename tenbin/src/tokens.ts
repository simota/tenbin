import { IMAGE_TOKENS_PER_USE } from "./config.js";

/**
 * Conservative token estimate over the JSON encoding the API receives (so quotes and escapes in
 * strings count). The docs quote ~32k tokens ≈ 150k chars of English, i.e. ~4.7 chars/token; we
 * use 4 so that estimates err high.
 */
export function estimateTokens(value: unknown, imageRefs: readonly string[] = []): number {
  const json = JSON.stringify(value ?? null);
  return Math.ceil(json.length / 4) + imageUses(json, imageRefs) * IMAGE_TOKENS_PER_USE;
}

/** Each place a reference appears adds another copy of the image to what the model reads. */
function imageUses(json: string, imageRefs: readonly string[]): number {
  let uses = 0;
  for (const ref of imageRefs) uses += json.split(JSON.stringify(ref).slice(1, -1)).length - 1;
  return uses;
}

export function estimateRequestTokens(state: unknown, questions: Record<string, unknown>, imageRefs: readonly string[] = []): {
  state: number;
  questions: number;
  longestQuestion: number;
  total: number;
} {
  const stateTokens = estimateTokens(state, imageRefs);
  let questionTokens = 0;
  let longest = 0;
  for (const q of Object.values(questions)) {
    const t = estimateTokens(q, imageRefs);
    questionTokens += t;
    if (t > longest) longest = t;
  }
  return { state: stateTokens, questions: questionTokens, longestQuestion: longest, total: stateTokens + questionTokens };
}
