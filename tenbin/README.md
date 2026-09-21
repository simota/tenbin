# Tenbin

Tenbin (天秤, "balance scale") is an MCP server for the [TypeSafe AI](https://docs.typesafe.ai) System One API (Jev). Lets a coding agent evaluate states with typed Choice / Score / Noul questions, batch-evaluate for threshold calibration, rerank candidates, walk taxonomies, and lint questions offline — with per-call and per-session cost guards.

Design notes: [`../docs/03-mcp-server-and-skill-design.md`](../docs/03-mcp-server-and-skill-design.md).

## Install / run

```bash
npm install && npm run build
export TYPESAFE_API_KEY=...        # https://console.typesafe.ai/settings/keys
node dist/index.js                 # stdio transport
```

Claude Code:

```bash
claude mcp add tenbin -e TYPESAFE_API_KEY=$TYPESAFE_API_KEY -- node /abs/path/tenbin/dist/index.js
# or keep the key in ~/.config/tenbin/env (KEY=value, chmod 600) and let a wrapper load it:
claude mcp add tenbin -- sh -c 'set -a; . "$HOME/.config/tenbin/env"; set +a; exec node /abs/path/tenbin/dist/index.js'
```

Generic `mcpServers` entry:

```json
{ "tenbin": { "command": "node", "args": ["/abs/path/tenbin/dist/index.js"], "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" } } }
```

Without `TYPESAFE_API_KEY` the server starts in offline mode and exposes `tenbin_lint_questions`, the `tenbin`, `design_integration`, `design_questions` and `decompose_judgment` prompts, and all guide/example resources.

## `tenbin` command: project-use suggestions

Select the `tenbin` prompt in the MCP client's prompt menu. It takes no arguments;
state a focus in the conversation first if needed. The coding agent uses the current
project and conversation to suggest grounded applications, including evidence,
Choice / Score / Noul judgments, integration points, uncertainty handling, and a
minimal validation plan. If project context is unavailable, it gives explicitly
general examples and asks for a summary. It does not call TypeSafe or edit files.

Example MCP request:

```json
{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"tenbin"}}
```

The response is a user message containing the shared suggestions guide, current API
availability, and instructions to use the current project. The host agent writes the
proposals; the MCP server does not scan the client's repository. The guide is embedded
so prompt-only clients do not need a second resource read. This works without a key.
Command display names depend on the client; this is an MCP prompt, not a tool or a new
shell subcommand. For the standalone skill, use `/tenbin` or `$tenbin` as supported by
the host. After updating a running server, rebuild and restart the MCP client/session.

## Contextual code and question generation

Select `design_integration` to design and generate code using Jev in the current
project. The host agent inspects the relevant types, runtime, SDK usage and test
conventions, designs state/questions, then implements SDK calls, decision logic,
failure handling, application wiring and mocked tests. Production calls the SDK
directly; generation needs no TypeSafe API key. A design-only request returns the
concrete design without edits. Paid model evaluation is separate and runs when requested.

Select `design_questions` to suggest or generate just state/questions. It produces
matching `{state, questions}` JSON, field sources, assumptions, type rationale and
an actual lint result. It can preserve an existing state or questions map and design
the other part. Missing context triggers a focused question; synthetic samples are
labelled and never presented as measured results.

Both prompts accept optional string arguments:

| Argument | Meaning |
|---|---|
| `context` | Relevant project flow, conversation excerpt or requirements; defaults to host context |
| `goal` | The decision or feature; when omitted, propose candidates and use the best-supported one |
| `sample_state` | Example input, either JSON encoded as a string or plain text |

```json
{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"design_integration","arguments":{"goal":"Route support tickets in the existing service"}}}
{"jsonrpc":"2.0","id":2,"method":"prompts/get","params":{"name":"design_questions","arguments":{"sample_state":"{\"ticket\":{\"message\":\"Please refund the duplicate charge.\"}}"}}}
```

Pass `arguments: {}` to use only the current context. The MCP SDK requires this
object for prompts with an argument schema, even when all fields are optional.
The argument-free `tenbin` prompt also embeds both guides and follows the request
in the conversation. `decompose_judgment` retains `judgment` and optional
`sample_state`, and shares the question-design workflow, now also offline.

The design prompts return a workflow message plus a separate JSON message carrying
supplied inputs; the host generates the artifacts. The server does not scan the
client's repository, invoke a code-generation model, or evaluate drafts automatically.
The guides are embedded for prompt-only clients and synced to the standalone skill.
Mocked tests verify code behavior, not Jev accuracy; thresholds remain provisional
until measured on labelled data.

## Tools

| tool | what | API |
|---|---|---|
| `tenbin_lint_questions` | static checks: level/option counts, numeric-only or degree-only levels, compound / counting / date instructions, inverted Noul criteria, missing state paths, token budget | none |
| `tenbin_evaluate` | one state × many questions; lint first (errors block, warnings returned); answers + usage + cost + request id + latency | 1 call |
| `tenbin_evaluate_many` | N states × same questions, concurrent; `repeat` for self-consistency; per-question mean/std, choice histogram | N×repeat calls |
| `tenbin_rank` | query × candidates → scores (noul fan-out, or Choice whose scores keep the final round's order between batch winners, keep losers below their own winner, and sum to 1); auto-batches past the token budget / 255-option cap, including the final rounds; optional `existence_check`. Design-time tool: noul mode packs many candidates into one state (the rerank cookbook sends one request per pair and measured its numbers that way; see jaggedness #5), and the cross-batch score combination is tenbin's own heuristic, not from a cookbook | ≥1 call |
| `tenbin_walk_taxonomy` | nested tree, one Choice per level with subtrees as option descriptions, beam search; levels over 255 options or the token budget are chunked and merged through a final round; a level with a single child is taken without a call and adds no edge to the path score (cookbook `is_decision`) | ≤1 call per level |
| `tenbin_list_models` | `GET /v1/models` + pricing | 1 call |
| `tenbin_session_stats` | calls, tokens, cost, remaining budget | none |

Resources: `tenbin://guide/{suggestions,integration-design,question-design,primitives,confidence,patterns,jaggedness,cookbooks}`, `tenbin://examples/{triage,guardrail,extraction}`.
Prompts: `tenbin`, `design_integration`, `design_questions`, `decompose_judgment` (all also offline), `design_thresholds`, `review_typesafe_code`.

## Configuration

| env | default | meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | – | required for API tools |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | model when a call omits `model` |
| `TENBIN_MAX_TOKENS_PER_CALL` | 60000 | estimated input tokens allowed per request (capped at the API's 64000) |
| `TENBIN_SESSION_TOKEN_BUDGET` | 20000000 | tokens this process may spend (≈ $0.84) |
| `TENBIN_CONCURRENCY` | 8 | parallel requests in `evaluate_many` and `rank` (both accept a per-call `concurrency` override) |
| `TENBIN_MAX_STATES` | 500 | states per `evaluate_many` call |

Token estimates use 4 chars/token over the JSON encoding (conservative) and enforce both API limits (64k total, 32k state + longest question). The session budget counts calls still in flight. Cost is input tokens × $0.042/Mtok; output tokens are free. Request bodies are never logged: the SDK logger is pinned to warn level on stderr regardless of `TYPESAFE_LOG_LEVEL`, because stdout is the MCP channel. A failed batch stops further scheduling in `rank`; in `evaluate_many` a failure that would hit every row (401/403) stops scheduling and reports the rest as `skipped`, while per-state failures (too large, 422) stay in their own row. Client cancellation (MCP abort) stops scheduling further requests in `evaluate_many` and `rank`; in-flight requests are aborted and reported as `cancelled`, not failures.

## Development

```bash
npm test          # build + node --test (lint rules, in-memory MCP client with a fake API)
npm run inspect   # MCP Inspector
```

The test suite runs without network or an API key: the TypeSafe SDK's `fetch` is replaced with a deterministic fake.
