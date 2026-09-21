# Repository Guidelines

## Project structure

- `README.md` and `docs/`: the official-docs map, workflow diagrams, the design document and the runbook. Document names use a number plus kebab-case, e.g. `02-workflows.md`. Do not restate the official docs; put condensed guidance in `tenbin/resources/` or `skills/tenbin/reference/`.
- `tenbin/src/`: the stdio MCP server, written in TypeScript. `index.ts` handles startup, `server.ts` registration, and `client.ts` the API connection.
- `src/tools/`: implementation of each MCP tool. Input schemas live in `src/schemas.ts`, configuration in `src/config.ts`.
- `src/*.test.ts`: tests colocated with the source. `resources/` holds the served Markdown guides and JSON samples; `dist/` is build output.
- `skills/tenbin/`: the Agent Skill. `SKILL.md`, `reference/` (the 8 guides, including `suggestions.md`, `question-design.md` and `integration-design.md`, are synced from the MCP's `resources/` with `scripts/sync_resources.sh`; `state.md`, `question-writing.md`, `thresholds.md` and `sdk.md` are skill-only), `templates/`, `scripts/` (`lint_questions.py` keeps the same rules as `src/lint.ts`; `evaluate.py` is a standard-library-only script that calls the API without the MCP).
- `Makefile`: `make link-claude|link-codex|link-agy` symlinks `skills/tenbin` into each CLI's skills directory. `make unlink` / `make status` / `make test` (tests for the skill scripts). For the MCP: `make env-file` / `make build-mcp` / `make register-claude` (wrapper registration via `claude mcp add`) / `make mcp-status` / `make unregister-claude`; all at once with `make install-claude`.
- `docs/04-runbook.md`: procedures for setup, operations, incident response and maintenance. Update it when you change configuration defaults or tool inputs/outputs.

## Build, test and local development

Use Node.js 20 or later and run the following after `cd tenbin`.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install dependencies according to the lockfile |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run typecheck` | Type-check without emitting files |
| `npm test` | Run the Node.js tests after building |
| `npm start` | Start the built stdio server |
| `npm run inspect` | Inspect the built server with MCP Inspector |

## Coding conventions

Keep TypeScript strict mode, ES modules and the NodeNext configuration. Match the existing code: 2-space indentation, double-quoted strings, semicolons at line ends, and a `.js` suffix on relative imports. Functions and variables are camelCase, types and classes PascalCase, constants UPPER_SNAKE_CASE. Tool file names follow the existing form of `evaluate_many.ts`.

No dedicated formatter or lint command is configured. Match the surrounding formatting, use the existing Zod schemas for input validation and `TypeSafeGateway` for API access.

## Testing policy

Use `node:test` and `node:assert/strict`, name files `*.test.ts`, and give tests English names that describe the behavior. Verify the API with a deterministic fake fetch and MCP connections with `InMemoryTransport`; never depend on the network or a real API key.

Add regression tests for the happy path, input errors, budget limits, cancellation and partial failure as appropriate to the behavior you changed. No numeric coverage target is set. Run `npm test` and `npm run typecheck` when you change code. Skill-side scripts are tested with `unittest` in `scripts/*_test.py` and run with `make test` at the repository root (`urlopen` is replaced; no network needed).

## Commits and Pull Requests

Follow the history and use English Conventional Commits such as `feat(mcp): add ...` or `docs: ...`. Group commits by purpose and do not include agent or vendor attribution.

A PR should state the purpose of the change, the behavior as seen by users, a link to the related issue if any, and the verification run with its results. When changing a tool's inputs or outputs, include an example and update the related README, design documents and served resources.

## Configuration and secrets

Pass the API key through the `TYPESAFE_API_KEY` environment variable and never include it in commits or logs. Without a key, the offline question lint tool is available. Reserve stdio's standard output for MCP traffic and write diagnostics to standard error. Do not log request bodies, and keep the existing token budget and concurrency limits. Do not commit `node_modules/` or `dist/`.
