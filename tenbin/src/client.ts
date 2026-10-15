import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  image,
  type Fetch,
  type Image,
  type Logger,
  type ModelCard,
} from "@typesafe-ai/sdk";
import { API_LIMITS, type Config } from "./config.js";
import { estimateRequestTokens } from "./tokens.js";
import type { Answer, EvaluateResult, Questions, Usage } from "./types.js";

export interface SessionStats {
  calls: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  budget_tokens: number;
  remaining_tokens: number;
}

const STDERR_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message, ...args) => console.error(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

export class BudgetExceededError extends Error {}
export class CallTooLargeError extends Error {}
export class AssetError extends Error {}

/** Image references mapped to the local files they stand for (MCP input). */
export type AssetPaths = Record<string, { path: string }>;

const IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";
const IMAGE_SIGNATURES = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Uint8Array.of(0xff, 0xd8, 0xff)];

/**
 * Reads each file and refuses anything that is not a PNG or JPEG, so a path cannot upload an
 * arbitrary local file. Size and dimension limits are left to the API, which rejects precisely.
 */
export async function loadImages(assets: AssetPaths): Promise<Record<string, Image>> {
  const out: Record<string, Image> = {};
  for (const [ref, { path }] of Object.entries(assets)) {
    if (!isAbsolute(path)) throw new AssetError(`asset "${ref}": path must be absolute, got ${path}`);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (err) {
      throw new AssetError(`asset "${ref}": cannot read ${path}: ${(err as Error).message}`);
    }
    if (!IMAGE_SIGNATURES.some((sig) => sig.every((b, i) => bytes[i] === b))) {
      throw new AssetError(`asset "${ref}": ${path} is not a PNG or JPEG file. Convert GIF, WebP or HEIC to PNG or JPEG first.`);
    }
    out[ref] = image(bytes);
  }
  return out;
}

/** Wraps the SDK client with per-call and per-session limits and usage accounting. */
export class TypeSafeGateway {
  private readonly client: TypeSafeClient;
  private calls = 0;
  private failures = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private reservedTokens = 0;

  constructor(private readonly config: Config, fetchImpl?: Fetch) {
    if (!config.apiKey) {
      throw new Error("TYPESAFE_API_KEY is not set. Create a key at https://console.typesafe.ai/settings/keys and export it before starting the server.");
    }
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      // stdout is the MCP channel and debug logs would include request bodies, so the SDK's
      // env-driven log level is overridden: warnings and errors only, on stderr.
      logger: STDERR_LOGGER,
      logLevel: "warn",
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  get defaultModel(): string {
    return this.config.defaultModel;
  }

  stats(): SessionStats {
    const used = this.inputTokens + this.outputTokens + this.reservedTokens;
    return {
      calls: this.calls,
      failures: this.failures,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cost_usd: this.cost(this.inputTokens),
      budget_tokens: this.config.sessionTokenBudget,
      remaining_tokens: Math.max(0, this.config.sessionTokenBudget - used),
    };
  }

  cost(inputTokens: number): number {
    return (inputTokens / 1_000_000) * this.config.pricePerMtokUsd;
  }

  /**
   * Throws before the call if the estimate breaks the per-call limits (total, and the API's
   * state + longest question rule) or the session budget, counting calls still in flight.
   */
  assertWithinLimits(state: unknown, questions: Questions, imageRefs: readonly string[] = []): number {
    const est = estimateRequestTokens(state, questions, imageRefs);
    if (est.total > this.config.maxTokensPerCall) {
      throw new CallTooLargeError(`estimated ${est.total} input tokens exceeds the per-call limit of ${this.config.maxTokensPerCall}. Send only the state fields the questions need, split states across tenbin_evaluate_many, or use tenbin_rank which batches automatically.`);
    }
    if (est.state + est.longestQuestion > API_LIMITS.stateAndLongestQuestionTokens) {
      throw new CallTooLargeError(`estimated state (${est.state}) + longest question (${est.longestQuestion}) tokens exceeds the API limit of ${API_LIMITS.stateAndLongestQuestionTokens}. Trim the state or split it across calls.`);
    }
    const committed = this.inputTokens + this.outputTokens + this.reservedTokens;
    if (committed + est.total > this.config.sessionTokenBudget) {
      throw new BudgetExceededError(`session token budget of ${this.config.sessionTokenBudget} would be exceeded (used or in flight ${committed}, this call ~${est.total}). Raise TENBIN_SESSION_TOKEN_BUDGET or start a new session.`);
    }
    return est.total;
  }

  async systemOne(state: unknown, questions: Questions, model?: string, signal?: AbortSignal, assets?: AssetPaths): Promise<EvaluateResult> {
    // Files are read before the budget check so that no await separates the check from the reservation.
    const images = assets && Object.keys(assets).length > 0 ? await loadImages(assets) : undefined;
    const reserved = this.assertWithinLimits(state, questions, images ? Object.keys(images) : []);
    this.reservedTokens += reserved;
    const experimental = images !== undefined || Object.values(questions).some((q) => q.type === "box");
    const options = {
      ...(signal ? { signal } : {}),
      ...(experimental ? { headers: { [IMAGES_HEADER]: "true" } } : {}),
    };
    const started = Date.now();
    this.calls += 1;
    try {
      const { data, requestId } = await this.client
        .systemOne({ state: state as never, questions: questions as never, ...(model ? { model } : {}), ...(images ? { assets: images } : {}) }, options)
        .withResponse();
      const usage = data.usage as Usage;
      this.inputTokens += usage.input_tokens ?? 0;
      this.outputTokens += usage.output_tokens ?? 0;
      return {
        model: data.model,
        answers: data.answers as unknown as Record<string, Answer>,
        usage,
        cost_usd: this.cost(usage.input_tokens ?? 0),
        request_id: requestId ?? undefined,
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      this.failures += 1;
      throw err;
    } finally {
      this.reservedTokens -= reserved;
    }
  }

  async listModels(): Promise<ModelCard[]> {
    return this.client.models.list();
  }
}

export function isCancellation(err: unknown): boolean {
  return err instanceof APIUserAbortError;
}

/**
 * Errors that will hit every request in a batch the same way, so continuing only spends time.
 * A budget rejection is not one of them: it depends on the size of each request, so a smaller
 * row may still fit.
 */
export function isBatchWideError(err: unknown): boolean {
  return err instanceof AuthenticationError || err instanceof PermissionDeniedError;
}

/** Turns SDK errors into messages that tell the agent what to do next. */
export function describeError(err: unknown): string {
  if (err instanceof BudgetExceededError || err instanceof CallTooLargeError || err instanceof AssetError) return err.message;
  if (isCancellation(err)) return "Request cancelled by the client.";
  if (err instanceof AuthenticationError) {
    return "TypeSafe rejected the API key (401). Check TYPESAFE_API_KEY; create a key at https://console.typesafe.ai/settings/keys.";
  }
  if (err instanceof UnprocessableEntityError) {
    return `TypeSafe rejected the request body (422): ${JSON.stringify(err.body)}. Run tenbin_lint_questions on the same questions to locate the offending field.`;
  }
  if (err instanceof RateLimitError) {
    const wait = err.retryAfterMs ? ` Retry after ${err.retryAfterMs} ms.` : "";
    return `Rate limited (429) after the SDK's automatic retries.${wait} Lower concurrency or split the batch.`;
  }
  if (err instanceof APIError && err.status === 413) {
    return `TypeSafe API error 413: ${err.message}. The request is over a size limit: 16 MiB per image file, 256–1568 px per side, 32 MiB for the body, all images, or the request with every reference expanded. Send fewer or smaller images, or move an image used by several questions into state.`;
  }
  if (err instanceof APIError && err.status === 400) {
    return `TypeSafe API error 400: ${err.message}. If the request has images: PNG or JPEG stills only, 256–1568 px per side, pixels rotated upright (EXIF orientation is not applied), every asset referenced, and Box needs model jev-preview.`;
  }
  if (err instanceof APIError) {
    return `TypeSafe API error ${err.status}: ${err.message}${err.status >= 500 ? " (temporary; retry shortly)" : ""}`;
  }
  if (err instanceof APITimeoutError) return `Request timed out after ${err.timeoutMs} ms. Reduce state size or retry.`;
  if (err instanceof APIConnectionError) return `Could not reach api.typesafe.ai: ${err.message}. Check network access.`;
  return err instanceof Error ? err.message : String(err);
}
