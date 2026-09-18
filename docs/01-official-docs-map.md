# 1. Official documentation map

The official docs at https://docs.typesafe.ai are authoritative and change without notice
(index: https://docs.typesafe.ai/llms.txt; append `.md` to any page path for Markdown). This
repository no longer restates them. The table says where each topic's *operative* version lives
here: the condensed rules a coding agent needs while designing, served by the skill
(`skills/tenbin/reference/`) and the MCP server (`tenbin://guide/*`, from `tenbin/resources/`).

| Topic | Official pages | In this repository |
|---|---|---|
| What System One / Jev is, RLCD, state basics | introduction, concepts/system-one, concepts/state, introduction/machine-learning-primer | `README.md` "TypeSafe in one minute"; `skills/tenbin/reference/state.md` |
| Choice / Score / Noul, request shape, limits | primitives, primitives/{choice,score,noul,advanced} | `reference/primitives.md` (= `tenbin://guide/primitives`), `reference/question-writing.md` (structured instructions, levels, criteria) |
| Confidence and thresholds | confidence, patterns/confidence-routing | `reference/confidence.md`, `reference/thresholds.md` |
| Patterns (fan-out, composite, intent routing, two-stage, verification, guardrail) | patterns/* , demos/smart-home | `reference/patterns.md`; diagrams in [02-workflows.md](02-workflows.md) |
| How to build a workflow, use-case map | concepts/how-to-build-with-system-one, concepts/use-case-map | `skills/tenbin/SKILL.md` steps 1–9; [02-workflows.md](02-workflows.md) |
| Jev 1.13 failure modes (jaggedness) | model-jaggedness/jev-1.13 | `reference/jaggedness.md` (carries the official "last reviewed" date) |
| HTTP API, models, pricing, rate limits, language support, data handling | api, models, legal | `reference/sdk.md` "Limits and price"; `tenbin/src/config.ts` (limits as constants); [04-runbook.md](04-runbook.md) §1 (data handling) |
| Python / JavaScript SDK | sdk, sdk/python/**, sdk/javascript/** | `reference/sdk.md`; `skills/tenbin/templates/*.py`, `questions.ts` |
| Cookbooks (18) | cookbooks/* | `reference/cookbooks.md` (= `tenbin://guide/cookbooks`): one line + URL each; techniques folded into `patterns.md`, `thresholds.md`, `question-writing.md` |
| Official agent skill | agent-skill, https://github.com/typesafe-ai/skills | `skills/tenbin/` is a superset with execution (see [03-mcp-server-and-skill-design.md](03-mcp-server-and-skill-design.md)) |

## Official site structure

```
introduction/            Introduction, Quick start, AI primer
concepts/                System One, State, How to build, Use case map
primitives/              Choice, Score, Noul, Advanced: structure
confidence
patterns/                fan-out, confidence-routing, composite-scoring, intent-routing
demos/                   smart-home
cookbooks/               18 cookbooks (consistency_noul, consistency_choice, parallel_questions, rerank,
                         semantic_find, autoformat, function_calling, skill_suggestion, entity_alignment,
                         classifying_rag_passages, citation_check, llm_guardrails, sde_cascade,
                         date_extraction, pre_parsed_value_extraction, hierarchical_classification,
                         autoresearch_feature_discovery, classification_using_confidence)
sdk/                     python (usage, changelog, api/**), javascript (changelog, api/**)
models, api, agent-skill, legal, model-jaggedness/jev-1.13
```

## Keeping the repository in step

When an official page changes, update `tenbin/resources/*.md` (then `scripts/sync_resources.sh`)
or the skill-only files under `skills/tenbin/reference/`, and the lint rules if a limit moved.
The maintenance checklist is in [04-runbook.md](04-runbook.md) §5.
