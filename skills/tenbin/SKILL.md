---
name: tenbin
description: "Design and generate project-specific code that uses Jev, including state/questions, SDK integration, decision logic and tests. Suggest Tenbin uses with /tenbin; suggest or generate state and questions from conversation, project context or sample input. Classify/route/triage, detect spam/abuse/injection, score severity/sentiment, rank, validate extraction or LLM answers, thresholds, guardrails. Also tenbin, TypeSafe, Jev, Choice/Score/Noul, calibrated probability, LLM labels, regex heuristics, classifier reliability. The host agent generates code; Jev evaluates typed judgments."
license: MIT
---

# TypeSafe judgments

Jev answers typed questions (Choice / Score / Noul) about a `state` with calibrated
probabilities. It does not generate text, count, calculate or compare dates. This skill
turns a broad decision into atomic questions, checks them, measures them on the user's
data, and puts thresholds in code with evidence behind them.

## `tenbin` command: suggest uses

When invoked as `/tenbin` (or `$tenbin` in clients that use that notation) without a
concrete task, or asked how Tenbin could help the current project, follow
[reference/suggestions.md](reference/suggestions.md). Use any text after the command
as the user's focus, then inspect the relevant project flow and propose grounded uses
with integration points and a minimal trial. No API key or MCP connection is needed.
Return proposals before entering the design procedure below; a bare invocation is not
permission to run paid evaluations or implement every idea. A concrete design,
evaluation, or implementation request goes directly to the relevant procedure.

The MCP equivalent is the `tenbin` prompt, which takes no arguments and uses the
current project and conversation. It includes the same guide, also served at
`tenbin://guide/suggestions`. Either entry is sufficient; do not invoke both recursively.

## Design and generate Jev integration code

For `/tenbin このプロジェクトに合うJev利用コードを設計・生成して` or a specific
integration request, follow [reference/integration-design.md](reference/integration-design.md).
Inspect the relevant project flow, conventions, types and tests. Design the input-to-action
path, generate and lint state/questions, then implement the SDK boundary, result handling,
application wiring and deterministic tests. A code-generation request continues through
local edits and verification; a design-only request stops at the concrete design.
Do not stop at a plan or questions JSON when usable application code was requested.

The MCP equivalent is `design_integration`, with optional `context`, `goal` and
`sample_state` strings (pass `arguments: {}` to use only the host context). The host
agent generates code; the resulting application calls Jev directly through the SDK.
An API key is unnecessary for generation and mocked tests. Without labelled evaluation,
mark thresholds provisional and use a conservative fallback. Only run paid evaluation
when requested; an absent key must not block local implementation.

## Suggest or generate state and questions

For `/tenbin 今の文脈からstateとquestionを生成して` or a request for just these
artifacts, follow [reference/question-design.md](reference/question-design.md).
Use the current goal, conversation, relevant files and any supplied input. Propose
candidates when the decision is not chosen; a generation request continues with the
best-supported one, producing `{state, questions}` JSON, field sources, assumptions
and an actual offline lint result. A suggestion-only request stops at candidates.
For a state-only or questions-only request, preserve the supplied counterpart.
If context cannot support a draft, ask one focused question rather than inventing it.

The MCP equivalent is `design_questions` with optional `context`, `goal` and
`sample_state` strings (`arguments: {}` for host context only). `decompose_judgment`
keeps its `judgment` / `sample_state` arguments and uses the same workflow. Both work
offline. The argument-free `tenbin` prompt embeds both design guides and routes by
the user's request. Stop after generation and lint unless evaluation, saving files
or implementation is already requested.

## Absolute rules

1. **Question ids are not sent to the model.** The complete question lives in `instructions`.
2. **All questions over the same state go in one request.** One question per call is the anti-pattern.
3. **Code does what code can do exactly**: arithmetic, counting, date comparison, regex, lookups. The model gets what is left.
4. **Score levels describe situations, 2–10 of them, one dimension per Score.** Choice ≤ 255 options; add `other` when the list may be incomplete.
5. **Thresholds start conservative and are set from the user's labelled data.** Never present a number as "the right threshold" without per-band accuracy behind it.
6. **API key only from `TYPESAFE_API_KEY`.** Never in code, examples, commits or logs. Server-side only in web apps.
7. **Do not mix primitives' numbers.** No comparing a Noul probability with a Choice confidence, no rebuilding an exact value from a Score position.

## Two modes

| | MCP server `tenbin` connected | No MCP |
|---|---|---|
| Suggest uses for this project | `tenbin` prompt, `tenbin://guide/suggestions` (also offline) | [reference/suggestions.md](reference/suggestions.md) |
| Design/generate Jev integration code | `design_integration` prompt, `tenbin://guide/integration-design` (also offline) | [reference/integration-design.md](reference/integration-design.md) |
| Suggest/generate state and questions | `design_questions` / `decompose_judgment` prompts, `tenbin://guide/question-design` (also offline) | [reference/question-design.md](reference/question-design.md) |
| Knowledge | `tenbin://guide/{primitives,patterns,confidence,jaggedness,cookbooks}` | `reference/*.md` (same content) |
| Lint | `tenbin_lint_questions` | `python scripts/lint_questions.py questions.json [--state state.json]` |
| Try a few inputs | `tenbin_evaluate` | `python scripts/evaluate.py request.json [--repeat 2]` |
| Measure on labelled data | `tenbin_evaluate_many` → `design_thresholds` prompt | `python scripts/evaluate.py questions.json --rows rows.jsonl [--repeat 2]`, read its per-band table, then follow [reference/thresholds.md](reference/thresholds.md) |
| Cost | `tenbin_session_stats` | `python scripts/estimate_cost.py` before; the `session` line of `evaluate.py` after |

Detect API-enabled MCP execution by the presence of `tenbin_evaluate` in the tool list.
An offline MCP still offers suggestions, state/question and code generation, resources,
and `tenbin_lint_questions`.
For a requested evaluation without `tenbin_evaluate`, run the scripts yourself:
they need only Python 3 and the key in `TYPESAFE_API_KEY` or
`~/.config/tenbin/env`. `evaluate.py` lints first and refuses on lint errors, like the MCP tool.
If the key is missing, do not state measured numbers you did not obtain; say what the user
must set (or run) to get them. `rows.jsonl` is one `{"state": ..., "labels": {"<id>": expected}}`
per line; write it from the user's CSV or DB in code, never by hand.

Live docs remain authoritative: `https://docs.typesafe.ai/llms.txt`, append `.md` to a page path.

## Procedure

### 1. Is this a System One judgment?

Yes when a knowledgeable person decides it in seconds from the text in front of them.
No when it needs generation, arithmetic, counting, date math, multi-hop reasoning or a
lookup ([reference/jaggedness.md](reference/jaggedness.md)). If code can decide it
deterministically, do not call the model. Say which parts of the request fall on each side.

### 2. Decompose

Write the decision as a list of atomic judgments. Assign a type to each:

- which one of a fixed set → **Choice** (code branches on `choice`)
- how much on a describable spectrum → **Score** (code thresholds `score`)
- is it true → **Noul** (code does `if noul > t`)

Add speculative questions that only matter for some inputs; code ignores the rest.
Add presence / "no match" outcomes (`other`, `not_stated`, a Noul "answer exists").
Split a compound judgment into one question per factor; combine in code.
Keep a second request only when the first answer is needed to *build* the second
(fetch data, choose the next options). See [reference/patterns.md](reference/patterns.md).

### 3. Design the state

Follow [reference/state.md](reference/state.md). Only the fields the questions need, as an object. Reference parts with backticked paths in
instructions: "Does `ticket.messages[0].text` ask for a refund?". Filter irrelevant text in
code first; large noisy state lowers accuracy. Limits: 64k tokens state + questions,
32k state + longest question. Text only: pre-process other media in code. English is the
primary training language; for Japanese or other non-English state, say so, measure on the
user's own data (step 6) and lean on confidence when routing.

### 4. Write the questions

Follow [reference/question-writing.md](reference/question-writing.md). Situations, not
degrees. Structured option descriptions (`what` / `not_for` / `examples`) when options are
confusable; structured `instructions` (`question` / `focus` / `field` …) or structured levels
with the same field names when a plain string blurs. Affirmative phrasing so a high Noul
means yes. No double negatives.

### 5. Lint

Run the lint (tool or script). Fix every error; fix or justify every warning. Do not show the
user questions that fail lint.
For a state/question-only request, return the draft and lint result here. For code
generation without requested live evaluation, continue to composition, implementation
and mocked tests with provisional thresholds; do not block on a key or labelled data.

### 6. Try it, then measure it

Run 2–3 representative inputs, including one edge case, and show the raw answers. Then ask for
labelled data (20+ rows per class is a floor; below that say the bands are unreliable). Run it
with `repeat` ≥ 2 if repeatability matters. Bucket by confidence (or Noul distance from 0.5),
report accuracy per band.

### 7. Thresholds and composition

Follow [reference/thresholds.md](reference/thresholds.md). Per-action thresholds scaled by
the cost of a wrong action: act / confirm / escalate. Composite scores: normalise each Score
by `len(criteria) - 1`, weighted sum in code. Questions, weights and thresholds live in
**one file** (`templates/questions.py` or `templates/questions.ts`).

### 8. Implement

Production code calls the SDK directly ([reference/sdk.md](reference/sdk.md)); the MCP
server is a design-time tool. Start from the closest template and match the user's codebase:

| need | template |
|---|---|
| questions + thresholds + weights in one file | `templates/questions.py`, `templates/questions.ts` |
| fan-out + confidence gate | `templates/triage.py` |
| input/output guardrail | `templates/guardrail.py` |
| labelled CSV → per-band accuracy table | `templates/eval_thresholds.py` |

### 9. Review

Before handing over, check the code against this list (the MCP `review_typesafe_code`
prompt does the same):

- one call carries all questions over the same state
- questions / thresholds / weights in one place
- nothing asks the model to count, compute, compare dates or generate
- no Noul-vs-confidence comparison, no probability × confidence
- one action built from several answers takes the minimum confidence, not the product
- several Nouls → one decision go through fixed-order gates, security first
- no exact number rebuilt from a Score
- state carries only fields a question uses
- instructions complete without the id; levels are situations, one dimension each
- `other` present where the option list may be incomplete
- every threshold has a per-band table behind it, or is marked provisional
- key from the environment, not code or logs

## Output of a design session

1. The split: what code decides, what the model decides, what stays with a human.
2. The `questions` map (linted) and the state shape.
3. Raw answers for the sample inputs, then the per-band table if labels exist.
4. The composition code with thresholds marked *measured* or *provisional*.
5. What was not verified and the command that would verify it.
