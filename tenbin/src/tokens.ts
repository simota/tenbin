/**
 * Conservative token estimate over the JSON encoding the API receives (so quotes and escapes in
 * strings count). The docs quote ~32k tokens ≈ 150k chars of English, i.e. ~4.7 chars/token; we
 * use 4 so that estimates err high.
 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? null).length / 4);
}

export function estimateRequestTokens(state: unknown, questions: Record<string, unknown>): {
  state: number;
  questions: number;
  longestQuestion: number;
  total: number;
} {
  const stateTokens = estimateTokens(state);
  let questionTokens = 0;
  let longest = 0;
  for (const q of Object.values(questions)) {
    const t = estimateTokens(q);
    questionTokens += t;
    if (t > longest) longest = t;
  }
  return { state: stateTokens, questions: questionTokens, longestQuestion: longest, total: stateTokens + questionTokens };
}
