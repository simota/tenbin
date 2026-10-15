/** Input-token price for jev-1.13.0 (docs: /models). Output tokens are free. */
export const PRICE_PER_MTOK_USD = 0.042;

/** API limits for jev-1.13 (docs: /models for the token limits, /primitives/choice for 255 options, /primitives/score for 2–10 levels). */
export const API_LIMITS = {
  totalTokens: 64_000,
  stateAndLongestQuestionTokens: 32_000,
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
} as const;

export interface Config {
  apiKey: string | undefined;
  defaultModel: string;
  maxTokensPerCall: number;
  sessionTokenBudget: number;
  concurrency: number;
  maxStates: number;
  pricePerMtokUsd: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiKey: env.TYPESAFE_API_KEY?.trim() || undefined,
    defaultModel: env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest",
    // Never above what the API accepts, whatever the environment says.
    maxTokensPerCall: Math.min(intEnv(env, "TENBIN_MAX_TOKENS_PER_CALL", 60_000), API_LIMITS.totalTokens),
    sessionTokenBudget: intEnv(env, "TENBIN_SESSION_TOKEN_BUDGET", 20_000_000),
    concurrency: intEnv(env, "TENBIN_CONCURRENCY", 8),
    maxStates: intEnv(env, "TENBIN_MAX_STATES", 500),
    pricePerMtokUsd: PRICE_PER_MTOK_USD,
  };
}

