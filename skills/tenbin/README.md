# tenbin skill

A TypeSafe (System One / Jev) design skill for coding agents. [SKILL.md](SKILL.md) defines the procedure for decomposing a judgment into atomic Choice / Score / Noul questions, then lint → trial → measure on labeled data → put thresholds in code. Execution goes through the [tenbin](../../tenbin/) MCP, or, where no MCP is available, `scripts/evaluate.py` (standard library only, run directly by the agent).

Invoke `/tenbin` (or `$tenbin` where supported) to propose uses that fit the current
project. A focus can follow the command, for example `/tenbin 検索機能を中心に`.
The agent inspects relevant files read-only and gives evidence, input and judgment
types, integration points, and a minimal trial, then recommends where to start.
Suggestions need neither an API key nor the MCP. A concrete implementation or
evaluation request proceeds directly to the existing design procedure. The MCP's
argument-free `tenbin` prompt provides the same discovery workflow.

Ask `/tenbin このプロジェクトに合うJev利用コードを設計・生成して` to produce a
working integration: state/questions, SDK calls, decision logic, failure handling,
application wiring and mocked tests, following the project's existing conventions.
The host agent writes code; the generated application uses Jev for runtime judgments.
Generation and local verification need no TypeSafe API key; model accuracy and
thresholds remain unmeasured until evaluated on labelled data.

For state/questions alone, ask `/tenbin 今の文脈からstateとquestionを生成して`.
The result is `{state, questions}` JSON with field sources, assumptions and offline lint.
Suggestions-only and state-only/questions-only requests are also supported.
The MCP equivalents are `design_integration` and `design_questions`, each with optional
`context`, `goal` and `sample_state` strings (send `arguments: {}` for host context only).
The existing `decompose_judgment` prompt uses the question-design workflow, also offline.

## Layout

| Path | Content |
|---|---|
| `SKILL.md` | Triggers, discovery command, absolute rules, branching on MCP availability, the 9 steps, review checklist |
| `reference/suggestions.md` | Project-use discovery: relevant evidence, capability matching, proposal output, offline fallback (synced from MCP resources) |
| `reference/integration-design.md` | Project-specific Jev code design/generation, SDK integration, wiring and local verification (synced) |
| `reference/question-design.md` | Contextual state/question suggestions and generation: sources, request JSON, assumptions and lint (synced) |
| `reference/state.md` | 8 principles of state design (only required fields, object, path references, deterministic processing in code, language, limits, sample_uid) |
| `reference/question-writing.md` | How to write instructions / criteria, with counterexamples |
| `reference/thresholds.md` | Procedure for deriving thresholds from accuracy per band, and when not to use a threshold |
| `reference/sdk.md` | Minimal Python / JS SDK code and limits |
| `reference/{primitives,patterns,confidence,jaggedness,cookbooks}.md` | Identical to the MCP server's `resources/` (synced with `scripts/sync_resources.sh`) |
| `templates/questions.py` / `questions.ts` | Template that gathers questions, thresholds and weights in one file |
| `templates/triage.py` | fan-out + confidence gate |
| `templates/guardrail.py` | Input/output guardrail (hazard Noul + severity Score) |
| `templates/eval_thresholds.py` | Labeled CSV → table of accuracy per confidence band |
| `scripts/lint_questions.py` | Same rules as the MCP's `tenbin_lint_questions` (offline) |
| `scripts/evaluate.py` | Equivalent of the MCP's `tenbin_evaluate` / `tenbin_evaluate_many`. lint → API call → accuracy-per-band table. No dependencies; key from `TYPESAFE_API_KEY` or `~/.config/tenbin/env` |
| `scripts/estimate_cost.py` | Estimate tokens and cost from state / questions |
| `scripts/evaluate_test.py`, `scripts/lint_questions_test.py` | Tests for `evaluate.py` (API replaced) and the lint rules; run with `make test` |

## Installation

Claude Code (personal):

```sh
make link-claude    # ~/.claude/skills/tenbin → skills/tenbin (codex / agy: make link)
```

For a per-project install, copy the whole directory to `.claude/skills/tenbin/`. Other agents such as Codex only need `SKILL.md` placed where they can read it. Invoke with "use the tenbin skill" or `/tenbin`.

To use the MCP server alongside it, register it following the steps in `tenbin/README.md`. The skill works without it: `scripts/evaluate.py` calls the API directly and reads the key from `TYPESAFE_API_KEY` or `~/.config/tenbin/env`.

## Maintenance

- After changing `tenbin/resources/*.md`, run `scripts/sync_resources.sh`.
- After changing lint rules in `tenbin/src/lint.ts`, apply the same change to `scripts/lint_questions.py`.
- Where the role overlaps with the official skill `typesafe-ai/skills`, the official one is authoritative. The differences are lint, the threshold procedure, MCP integration and templates.
