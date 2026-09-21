import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function user(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer, apiAvailable: boolean): void {
  server.registerPrompt(
    "tenbin",
    {
      title: "Suggest Tenbin uses for the current project",
      description: "Inspect the current project and conversation, then propose grounded uses for Tenbin with integration points and a minimal validation plan. Works without an API key; does not run evaluations or change files.",
    },
    async () => {
      const guide = await readFile(new URL("../resources/suggestions.md", import.meta.url), "utf8");
      return user(`${guide}

## Current MCP availability

${apiAvailable
  ? "The API tools are registered. This command still makes no TypeSafe API calls; evaluation is a later step when requested."
  : "This server is offline: only tenbin_lint_questions, this tenbin prompt, and guide/example resources are available. Proposal work needs no API key. Evaluation requires setting TYPESAFE_API_KEY and restarting the server, or using the skill's evaluate.py with a key."}

## Project context

Use the current project and conversation, including any focus the user has already stated. Follow the guide's fallback if that context is unavailable.`);
    },
  );

  if (!apiAvailable) return;

  server.registerPrompt(
    "decompose_judgment",
    {
      title: "Decompose a judgment into atomic TypeSafe questions",
      description: "Turns a broad judgment into a set of narrow Choice/Score/Noul questions plus a composition formula for code",
      argsSchema: { judgment: z.string().describe("The decision the software needs, in plain words"), sample_state: z.string().optional().describe("An example input (JSON or text)") },
    },
    ({ judgment, sample_state }) =>
      user(`Read tenbin://guide/primitives and tenbin://guide/jaggedness first.

Judgment to implement: ${judgment}
${sample_state ? `Sample state:\n${sample_state}\n` : ""}
Produce:
1. What code can decide deterministically before any model call (rules, lookups, arithmetic, dates).
2. A JSON "questions" map for one tenbin_evaluate call. Every question is one atomic judgment a knowledgeable person makes in seconds. For each: the type and why (choice = which one, score = how much on described situations, noul = is it true), complete instructions (ids are not sent to the model), criteria with an "other" option where the list may be incomplete, and backticked paths into the state.
3. Speculative questions to include even though they matter only for some inputs.
4. The composition in code: weights, thresholds, and which answers gate which actions, with confidence bands (act / confirm / escalate).
5. What must NOT be asked of the model (counting, math, date comparison, generation) and how code covers it.
Then run tenbin_lint_questions on the map and fix every error and warning before showing the result.`),
  );

  server.registerPrompt(
    "design_thresholds",
    {
      title: "Choose confidence thresholds from evaluate_many results",
      description: "Given labelled results, proposes high/medium/low bands and the action for each",
      argsSchema: { summary_json: z.string().describe("Output of tenbin_evaluate_many (rows + summary), ideally with a label per state"), stakes: z.string().optional().describe("What a wrong automatic action costs") },
    },
    ({ summary_json, stakes }) =>
      user(`Read tenbin://guide/confidence.

Results:\n${summary_json}
${stakes ? `Stakes of a wrong automatic action: ${stakes}\n` : ""}
For each question: bucket rows by confidence (or noul distance from 0.5) into at least 5 bands and report accuracy per band where labels exist. Propose the boundaries for act / confirm / escalate so that the automatic band meets the stakes, state the automation rate each choice implies, and warn where bands have too few rows to trust. Different actions get different thresholds. Never present a threshold as correct without the per-band numbers behind it; if labels are missing, say what data is needed.`),
  );

  server.registerPrompt(
    "review_typesafe_code",
    {
      title: "Review code that calls TypeSafe",
      description: "Checks a file for the anti-patterns the docs warn about",
      argsSchema: { code: z.string().describe("Source code to review") },
    },
    ({ code }) =>
      user(`Read tenbin://guide/jaggedness and tenbin://guide/confidence, then review this code:

\`\`\`
${code}
\`\`\`

Report findings with line references under these checks:
- one question per call (should be one call with all questions over the same state)
- questions, thresholds and weights scattered (should live in one place)
- asking the model to count, compute, compare dates, or generate text
- comparing a Noul probability with a Choice confidence, or multiplying probabilities by confidence
- reconstructing an exact number from a Score position
- state that includes fields no question uses
- question ids carrying meaning that instructions lack
- Score levels that are degrees rather than situations, or that mix dimensions
- missing "other" option on Choices whose list may be incomplete
- thresholds presented without evidence from the team's own data
- API key in code or logs`),
  );
}
