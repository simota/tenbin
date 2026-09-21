# Tenbin

A repository for **using [TypeSafe AI](https://docs.typesafe.ai)** (System One API, model Jev) **from a coding agent at design time**. It has three parts.

| Component | Location | Role |
|---|---|---|
| Documentation | [`docs/`](docs/) | Map of the official docs to this repo, workflow diagrams and LLM-integration use cases, design doc, runbook |
| MCP server | [`tenbin/`](tenbin/) | stdio MCP. Question lint, evaluation, batch evaluation (threshold calibration), rerank, taxonomy exploration, cost guard |
| Agent Skill | [`skills/tenbin/`](skills/tenbin/) | Procedure + templates + offline lint for decomposing a judgment into Choice / Score / Noul, measuring, and putting thresholds in code |

Operational procedures (setup, daily work, incident response, maintenance) are in [docs/04-runbook.md](docs/04-runbook.md). Conventions for agents are in [AGENTS.md](AGENTS.md).

## What you can do

Ask your coding agent for a judgment your code needs, and it comes back with a measured design, not a prompt:

| You ask | What you get | Behind it |
|---|---|---|
| `/tenbin` / "Where could Tenbin help this project?" | Proposals grounded in the current project and conversation: evidence, input and judgment type, integration point, uncertainty handling, and the smallest useful trial | skill discovery mode or MCP `tenbin` prompt; no API call |
| "Design and generate Jev code for this project" | Project-specific state/questions, SDK calls, decision logic, failure handling, application wiring and mocked tests | skill contextual integration or MCP `design_integration`; generation needs no API key |
| "Generate state and questions from this context" / "Suggest questions for this input" | Matching `{state, questions}` JSON, field sources, assumptions, type rationale and offline lint; candidates only when suggestions are requested | skill contextual question design or MCP `design_questions` / `decompose_judgment`; no API call |
| "Triage these support tickets into billing / technical / sales and flag the angry ones" | Atomic Choice / Score / Noul questions, linted; raw answers on a few of your tickets; accuracy per confidence band on your labelled rows; thresholds in one file with the measurement date; production code that calls the SDK | skill steps 1–9, `tenbin_evaluate`, `tenbin_evaluate_many` |
| "Add a guardrail to our chatbot" | Input and output hazard batteries, a hazard → block / review / support map, severity that escalates a review, cookbook thresholds marked provisional until measured | `templates/guardrail.py` |
| "Re-rank these 500 search results for this query" or "which of these 200 tools fits this turn?" | Scores per candidate from one Noul per pair, or a tournament of Choices, plus a "does anything fit at all" check | `tenbin_rank` |
| "Put each product into our 3-level category tree" | Beam search down the taxonomy with the probability of each edge, and the cost | `tenbin_walk_taxonomy` |
| "Check the values our extractor pulled from these invoices" / "did the LLM answer cite the document correctly?" | Per-field verification Nouls worded so the escalate case is the true case, aggregated with `max`; a citation Choice with a confidence gate | skill reference `patterns.md`, `question-writing.md` |
| "Is this question a good one for Jev?" | Lint findings with fixes (compound questions, counting, date math, degree-only levels, missing state paths, token budget), no API call | `tenbin_lint_questions` or `scripts/lint_questions.py` |
| "How much will 10,000 calls cost?" / "what have we spent this session?" | Token and cost estimate before; calls, tokens, cost and remaining budget after | `scripts/estimate_cost.py`, `tenbin_session_stats` |

Everything runs at design time. The output is code and numbers you own; production calls the TypeSafe SDK directly and never depends on the MCP.

Without the MCP registered, the skill still designs and generates code in the project,
lints with `skills/tenbin/scripts/lint_questions.py`, and evaluates and measures through
`skills/tenbin/scripts/evaluate.py` (Python 3, no SDK). Re-ranking and the taxonomy walk
need the MCP. Without an API key, project-use suggestions, state/question and code
generation, lint and cost estimates still work.

### Start with `tenbin`

Invoke the skill with `/tenbin` (or `$tenbin` in clients that use that notation) to find
uses in the current project. Add a focus such as `/tenbin 問い合わせ対応を中心に`.
The agent inspects relevant project files read-only and proposes a short list with a
recommended first experiment. It stops at proposals unless you have already requested
implementation or evaluation. With no accessible project context, it labels suggestions
as general examples and asks for a project summary.

With just the MCP, select the **`tenbin` prompt** in your client's prompt menu. It takes
no arguments and uses the current conversation and project; state any focus in the
conversation first. The client controls how MCP prompts appear as commands. The prompt
includes the shared `tenbin://guide/suggestions` guide and works without an API key.
The shell executable `tenbin` continues to start the stdio MCP server.

### Generate Jev integration code from project context

Ask `/tenbin このプロジェクトに合うJev利用コードを設計・生成して`, optionally naming
a feature or supplying sample input. The agent inspects the relevant project flow,
types, dependencies and tests, then designs and implements a complete integration:
state construction, linted questions, SDK calls, result interpretation, failure
handling, application wiring and mocked tests. A design-only request stops at the
concrete design. The host agent generates the code; the application calls Jev for
typed judgments at runtime.

With the MCP, select **`design_integration`**. Optional arguments are `context`, `goal`
and `sample_state`, all strings. Direct MCP requests must include `arguments`, even
when empty; `{}` uses only the host's current conversation and project:

```json
{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"design_integration","arguments":{"goal":"Route support tickets using Jev in this project's existing service"}}}
```

For state and questions alone, ask `/tenbin 今の文脈からstateとquestionを生成して` or
select **`design_questions`** with the same optional arguments. It returns a copyable
`{state, questions}` request, field sources, assumptions and offline lint. It also
supports suggestions only, or generating one part to match the supplied counterpart.
`sample_state` accepts JSON encoded as a string or plain text. The existing
`decompose_judgment` prompt shares this question-design workflow and now works offline.

The argument-free `tenbin` prompt embeds both design guides and routes by the user's
request. No TypeSafe key is needed for generation or mocked tests. Paid evaluation
runs only when requested; model accuracy and thresholds remain unmeasured until
validated on labelled data. See the [integration guide](tenbin/resources/integration-design.md)
and [state/question guide](tenbin/resources/question-design.md) for the output contracts.

### A session in brief

> **You:** use the tenbin skill — from a product review, tell me whether the customer wants a refund, what caused the damage, and how hostile the tone is.
>
> **Agent:** splits it into `wants_refund` (Noul), `damage_cause` (Choice with `other`), `tone` (4-level Score whose levels are situations), lints them (0 errors), then runs one review through the API:
>
> ```
> wants_refund  noul 0.98
> damage_cause  shipping_damage  confidence 1.00
> tone          score 1.29 / 3   confidence 0.58   (levels 1 and 2 split the probability)
> 521 input tokens, $0.00002, 650 ms, model jev-1.13.0
> ```
>
> It flags `tone` as the weak question (levels 1 and 2 overlap), asks for 20+ labelled reviews per class, and after `tenbin_evaluate_many` with `repeat: 2` reports accuracy per confidence band and proposes per-action thresholds marked *provisional* until that table exists. The result is one `questions.py` with the questions, weights and thresholds, and a triage function that calls the SDK.

## TypeSafe in one minute

- **Jev** = TypeSafe's flagship model, the first **System One model**. It generates no text: it evaluates typed `questions` against a `state` (the thing being judged) in parallel and returns **typed values + calibrated probability distributions**.
- Three primitives: **Choice** (one of a set of options → `choice`/`probabilities`/`confidence`), **Score** (position on ordered levels → `score`/`legend`/`probabilities`/`confidence`), **Noul** (yes/no → `noul` 0–1, no confidence).
- Design philosophy: **code owns the control flow; AI makes only narrow, atomic judgments**. Decompose broad judgments and combine the answers with weights and thresholds in code. Put every question about the same state into one request (extra questions add almost zero latency).
- `confidence` is the second axis that separates "execute / confirm / hand to a human". Vary the threshold with the risk of the action.
- The training method is **RLCD** (Reinforcement Learning for Calibrated Decisions). It avoids RLHF's sycophancy / mode dropping and optimizes so probabilities match the actual accuracy.
- One endpoint: `POST https://api.typesafe.ai/v1/systemone`. Model `jev-1.13.0` (alias `jev-latest`), $0.042/Mtok billed on input, output free. About 100 ms.
- Weak at: arithmetic, counting, date comparison, multi-hop indirection, generation, adversarial input. → Do the computation in code, convert extraction into a Choice.

## Quick start

Prerequisites: Node.js 20 or later, a TypeSafe API key (https://console.typesafe.ai/settings/keys).

```sh
git clone <this repo> && cd tenbin

# 1. MCP server
make env-file          # create ~/.config/tenbin/env with chmod 600 → write TYPESAFE_API_KEY=...
make build-mcp         # npm ci + build in tenbin/
make register-claude   # claude mcp add tenbin (registered via a wrapper that reads the env file)
# All at once: make install-claude (env-file + build-mcp + register-claude + link-claude)

# 2. Skill (example for Claude Code personal settings)
make link-claude   # symlink ~/.claude/skills/tenbin → skills/tenbin (codex / agy: make link)
```

The MCP starts without a key, with `tenbin_lint_questions`, the `tenbin`, `design_integration`, `design_questions` and `decompose_judgment` prompts, and guide/example resources available (offline mode). The skill works without registering the MCP: `skills/tenbin/scripts/evaluate.py` calls the API directly with the key from `~/.config/tenbin/env`. See Runbook §2 for passing the key directly via an environment variable and for other agents' configuration formats.

Tell the agent "use the tenbin skill" to start with project-use suggestions, or supply a concrete judgment to proceed through: decompose → lint → evaluate a few samples → accuracy per band on labeled data → put thresholds in code. Production code calls the SDK directly, not the MCP.

## Configuration

Everything is configured through environment variables. The recommended place for them is
`~/.config/tenbin/env` (`KEY=value`, one per line, `chmod 600`; `make env-file` creates it):

```sh
TYPESAFE_API_KEY=...               # required for anything that calls the API
TYPESAFE_DEFAULT_MODEL=jev-latest  # optional
TENBIN_CONCURRENCY=8               # optional
```

The MCP wrapper registered by `make register-claude` sources this file at start-up, and
`skills/tenbin/scripts/evaluate.py` reads it when `TYPESAFE_API_KEY` is not already set, so the
key never lands in a shell rc file or in Claude's config. Plain environment variables work too
(`claude mcp add tenbin -e TYPESAFE_API_KEY=$TYPESAFE_API_KEY -- node .../dist/index.js`).

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | – | API key from https://console.typesafe.ai/settings/keys. Without it the MCP offers suggestions, state/question and code generation, lint, and resources offline |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Model when a call omits `model`; pin `jev-1.13.0` while calibrating thresholds |
| `TENBIN_MAX_TOKENS_PER_CALL` | `60000` | Estimated input tokens allowed per request (capped at the API's 64000) |
| `TENBIN_SESSION_TOKEN_BUDGET` | `20000000` | Tokens one MCP process may spend (≈ $0.84); `BudgetExceededError` after that |
| `TENBIN_CONCURRENCY` | `8` | Parallel requests in `evaluate_many` and `rank`; lower it on 429 |
| `TENBIN_MAX_STATES` | `500` | States per `evaluate_many` call |

`TENBIN_*` values must be positive integers; an invalid value fails at start-up. Change the
file, then restart the Claude Code session so the MCP picks it up. Never set
`TYPESAFE_LOG_LEVEL=debug` in production: the SDK logs request bodies unredacted.
Details and other clients' formats: [docs/04-runbook.md](docs/04-runbook.md) §2.

## Verifying it works

```sh
cd tenbin
npm test            # build + node:test (fake API, no network or key needed)
npm run typecheck
npm run inspect     # inspect tools and resources visually in MCP Inspector
python3 ../skills/tenbin/scripts/lint_questions.py resources/examples/triage.json
```

## Contents

| # | File | Content |
|---|---|---|
| 1 | [docs/01-official-docs-map.md](docs/01-official-docs-map.md) | Where each official topic's operative version lives in this repo (skill reference, MCP guides), official site structure, how to keep in step |
| 2 | [docs/02-workflows.md](docs/02-workflows.md) | Mermaid diagrams of the typical workflows (basic cycle, triage, intent routing, confidence gate, composite, two-stage, guardrail, division of responsibilities) and use cases combined with an existing LLM |
| 3 | [docs/03-mcp-server-and-skill-design.md](docs/03-mcp-server-and-skill-design.md) | Design of the MCP server (evaluate / evaluate_many / rank / walk_taxonomy / lint / resources / prompts) and the Agent Skill, session examples, eval plan, roadmap |
| 4 | [docs/04-runbook.md](docs/04-runbook.md) | Runbook: setup, agent registration, daily operations (design sessions, calibration, cost), incident response table, maintenance and pre-release checks |

The condensed guidance an agent needs while designing lives in `skills/tenbin/reference/` (state, question writing, thresholds, SDK) and `tenbin/resources/` (primitives, patterns, confidence, jaggedness, cookbooks; served as `tenbin://guide/*`). The official docs at https://docs.typesafe.ai remain authoritative.

External links: Console https://console.typesafe.ai / Playground https://console.typesafe.ai/playground / Skill repo https://github.com/typesafe-ai/skills / Manifesto https://typesafe.ai/manifesto
