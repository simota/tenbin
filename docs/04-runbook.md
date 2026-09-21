# 4. Runbook: setup, daily operation, incident response, maintenance

Audience: people using `tenbin` (stdio MCP) and `skills/tenbin` (Agent Skill). This does not explain the specification. Each procedure states what to do and what output means it worked.

---

## 1. Prerequisites

| Item | Requirement | Check |
|---|---|---|
| Node.js | 20 or later | `node -v` |
| Python | 3.10 or later (only for the skill's scripts / templates; not needed for the MCP) | `python3 --version` |
| API key | Issued at https://console.typesafe.ai/settings/keys. **Passed only via the `TYPESAFE_API_KEY` environment variable** | `test -n "$TYPESAFE_API_KEY" && echo ok` |
| Network | HTTPS to `api.typesafe.ai` | `curl -sS -o /dev/null -w '%{http_code}\n' https://api.typesafe.ai/v1/models -H "Authorization: Bearer $TYPESAFE_API_KEY"` -> `200` |
| Cost | $0.042 per 1M input tokens, output free. Default session budget 20M tokens ≈ $0.84 | `tenbin_session_stats` |

Never put the key in code, config files, commits, logs or chat pastes. Store it in `~/.config/tenbin/env` (§2.2) or an environment variable. When passing it to `claude mcp add -e`, pass it by expanding `$TYPESAFE_API_KEY`.

Data handling: the body of `state` is sent to TypeSafe. The official docs state that requests and responses are not used for training; retention terms are in the DPA (https://typesafe.ai/legal/data-processing), and zero data retention is for enterprise (privacy@typesafe.ai). The MCP pins its log level to warn, but code that calls the SDK directly (the templates) logs request bodies verbatim with `TYPESAFE_LOG_LEVEL=debug` (the official SDK does not redact bodies). Do not use debug in production.

---

## 2. Setup

### 2.1 MCP server

```sh
cd tenbin
npm ci
npm run build
node dist/index.js        # "[tenbin] ready (model jev-latest)" on stderr means it worked. Ctrl-C to exit
```

Without the key, the following appears and the server starts in **offline mode** (suggestions, lint, and resources):

```
[tenbin] TYPESAFE_API_KEY is not set. ...
[tenbin] Starting in offline mode: tenbin_lint_questions, the tenbin prompt, and guide/example resources are available.
```

### 2.2 Storing the key (the `~/.config/tenbin/env` approach)

Instead of exporting it permanently in the shell rc, keep it in a dedicated file that only the processes that need it read. The server reads only environment variables, so the shell bridges file -> environment variable.

```sh
mkdir -p ~/.config/tenbin
printf 'TYPESAFE_API_KEY=%s\n' 'your key here' > ~/.config/tenbin/env
chmod 600 ~/.config/tenbin/env
```

`.env` format (`KEY=value`, one variable per line, no quotes). `TYPESAFE_DEFAULT_MODEL` and `TENBIN_*` can go in the same file.

How to load it:

| Use | Method |
|---|---|
| MCP registration | Wrapper `sh -c 'set -a; . "$HOME/.config/tenbin/env"; set +a; exec node .../dist/index.js'` (§2.3) |
| Interactive shell / skill scripts | `set -a; . ~/.config/tenbin/env; set +a` (only when needed. Handy as a `tenbin-env` function) |
| Checking a direct launch | `sh -c 'set -a; . ~/.config/tenbin/env; set +a; exec node dist/index.js'` -> `[tenbin] ready (model jev-latest)` |

Migrating from the old path `~/.config/typesafe/env`: `mv ~/.config/typesafe ~/.config/tenbin`, then re-register the §2.3 wrapper with the new path (`claude mcp remove tenbin` -> `claude mcp add ...`).

Check: `ls -l ~/.config/tenbin/env` shows `-rw-------`. `git grep` finds no actual key value in the repository (§5.5).

### 2.3 Registering with the agent

Claude Code:

Passing the environment variable directly:

```sh
claude mcp add tenbin -e TYPESAFE_API_KEY=$TYPESAFE_API_KEY -- node /abs/path/tenbin/dist/index.js
```

Reading from `~/.config/tenbin/env` (the key ends up in neither the registration command nor Claude's config file; recommended). `make register-claude` at the repository root runs the same command (replacing any existing registration; see also `make env-file` / `make build-mcp` / `make mcp-status` / `make unregister-claude`):

```sh
claude mcp add tenbin -- sh -c 'set -a; . "$HOME/.config/tenbin/env"; set +a; exec node /abs/path/tenbin/dist/index.js'
```

```sh
claude mcp list          # tenbin shows as connected
```

`mcpServers` format (Codex, Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "tenbin": {
      "command": "sh",
      "args": ["-c", "set -a; . \"$HOME/.config/tenbin/env\"; set +a; exec node /abs/path/tenbin/dist/index.js"]
    }
  }
}
```

For clients that pass environment variables directly: `"command": "node"`, `"args": [".../dist/index.js"]`, `"env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }`. If the client does not support expansion, keep that config file out of version control.

Check after registration: have the agent call `tenbin_list_models` and confirm it returns `jev-latest` / `jev-preview` with prices. The list does not include what the aliases point to, so call `tenbin_evaluate` once and confirm the response's `model` is `jev-1.13.0`.

### 2.4 Skill

```sh
make link-claude    # Claude Code, personal (~/.claude/skills/tenbin -> skills/tenbin). For codex / agy use make link; make unlink to remove; make status to check
# or copy the whole directory into .claude/skills/tenbin/ inside the project
```

Check: invoke `/tenbin` (or `$tenbin` where supported) and it proposes uses grounded in
the current project, with evidence and a first trial. For a concrete judgment request,
it returns a decomposition that follows the absolute rules (question IDs are not sent,
all questions in one call, computation in code).

### 2.5 Environment variables (optional)

| Variable | Default | When to raise / lower |
|---|---|---|
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Pin to `jev-1.13.0` during calibration work that needs reproducibility |
| `TENBIN_MAX_TOKENS_PER_CALL` | 60000 (API limit 64000) | Raise for large states. Anything over the limit is rejected by the API |
| `TENBIN_SESSION_TOKEN_BUDGET` | 20000000 (≈ $0.84) | Raise for large calibrations (thousands of states × repeat). Once exhausted, further calls fail with `BudgetExceededError` |
| `TENBIN_CONCURRENCY` | 8 | Lower if you see 429. The rate limit returns 429 when either 1,200 req/min or 250,000 tokens/sec is exceeded (subject to change). With large states × concurrency, tokens/sec is hit first. Cookbooks report hitting the limit around 8 in parallel on a shared key, so go above 8 only with evidence |
| `TENBIN_MAX_STATES` | 500 | Cap on states per `evaluate_many` call |

Positive integers only. An invalid value is a startup error.

---

## 3. Daily operation

### 3.0 Find a use in the current project

Use the skill's `/tenbin`, optionally with a focus such as
`/tenbin 問い合わせ対応を中心に`. With the MCP alone, select the `tenbin` prompt in the
client's prompt menu; it takes no arguments and uses the current conversation and
project. State a focus in the conversation first. Prompt display names vary by client.

The equivalent MCP request is
`{"jsonrpc":"2.0","id":1,"method":"prompts/get","params":{"name":"tenbin"}}`.
It returns a user message containing the shared guide and API availability. The host
agent reads relevant project files and proposes use cases with evidence, input and
judgment type, integration point, uncertainty handling, and a minimal trial. Without
project access, it labels general examples and asks for context. No TypeSafe API call
or file change is made for suggestions; no key is required.

Choose a proposal (or use its copyable follow-up request) to start §3.1. If the original
request already specified implementation or evaluation, the agent proceeds directly.
After updating an installed MCP, run `npm run build` in `tenbin/` and restart the
MCP client/session. Check that `prompts/list` contains `tenbin` and the prompt opens
without arguments, including offline.

### 3.1 Design session (skill steps 1–9)

1. Decompose the judgment and write `questions` (the `decompose_judgment` prompt).
2. `tenbin_lint_questions`. Fix until **0 errors**. Fix warnings or write down why not.
3. `tenbin_evaluate` on 2–3 cases (include boundary cases). Inspect the raw answers.
4. `tenbin_evaluate_many` on labeled data (20+ rows per class). Use `repeat: 2` to check reproducibility too.
5. Pass the summary to the `design_thresholds` prompt and decide thresholds from accuracy per band.
6. Put questions, thresholds and weights in one file (`skills/tenbin/templates/questions.*`). Annotate thresholds with the measurement date and row count.
7. Review the code with the `review_typesafe_code` prompt.
8. Production calls the SDK directly. The MCP is for design time only.

Without MCP, run the same steps with `skills/tenbin/scripts/lint_questions.py` and `scripts/evaluate.py` (a single call via `request.json`, or a labeled batch via `--rows rows.jsonl`. The key comes from `TYPESAFE_API_KEY` or `~/.config/tenbin/env`). Mark any threshold not backed by numbers as "provisional".

### 3.2 Re-running calibration (when questions, model or data change)

```
tenbin_evaluate_many(states=<labeled>, questions=<current>, model="jev-1.13.0", repeat=2)
```

Compare with the previous accuracy-per-band table. If accuracy in the automation band dropped, move the thresholds back to the conservative side. Keep the result JSON with a date (it contains no key).

### 3.3 Checking cost

- During a session: `tenbin_session_stats` (calls, tokens, cost, remaining budget).
- Estimating ahead: `python3 skills/tenbin/scripts/estimate_cost.py request.json --calls N`.
- Rule of thumb: triage with a 300-token state, 1,000 rows × repeat 2, is about $0.03.

### 3.4 Large inputs

- `rank`: over 255 candidates / over the token cap is batched automatically with a final round. Add `existence_check` to also detect "no match".
- `walk_taxonomy`: chunked automatically per level. Lowering `subtree_token_limit` summarizes the descriptions.
- `evaluate_many`: above 500 states, split into multiple calls.

---

## 4. Incident response

First look at stderr (the client's MCP log) and `tenbin_session_stats`. Error messages in tool results include the next action.

| Symptom | Cause | Action |
|---|---|---|
| Only `tenbin_lint_questions` in the tool list | Started offline without a key; the `tenbin` prompt and resources remain available | For evaluation, set `TYPESAFE_API_KEY` and restart the MCP (restart the client). With the env-file approach, check that `~/.config/tenbin/env` exists, its permissions, and the `KEY=value` format |
| `TypeSafe rejected the API key (401)` | Key invalid or revoked | Issue a new key in the Console and update the environment variable. `evaluate_many` stops on 401/403 and marks the remaining rows `skipped` |
| `rejected the request body (422)` | Invalid criteria format, level count or option count | Run the same questions through `tenbin_lint_questions`. If lint passes and you still get 422, suspect a SDK / API discrepancy and check against the official API reference (https://docs.typesafe.ai/api) |
| `Rate limited (429) after the SDK's automatic retries` | Too much concurrency | Lower `TENBIN_CONCURRENCY` (4 -> 2), or lower it with the tool's `concurrency` argument. Split the batch |
| `estimated N input tokens exceeds the per-call limit` | State is large | Send only the fields the questions need. Multiple states go through `evaluate_many`, candidate lists through `rank` |
| `state + longest question ... exceeds the API limit of 32000` | One question is huge (long option descriptions) | Shorten the option descriptions, lower `subtree_token_limit` in `walk_taxonomy` |
| `session token budget ... would be exceeded` | Budget consumed | Raise `TENBIN_SESSION_TOKEN_BUDGET` and restart, or start a new session. In-flight calls count as reservations |
| `Request cancelled by the client.` / `cancelled` in rows | Interrupted on the agent side | Normal. Re-run to continue (results are not retained) |
| `Could not reach api.typesafe.ai` | Network / proxy | Check connectivity with the curl in §1. In a sandbox, allow the host |
| `TypeSafe API error 5xx` | API-side outage | Wait a few minutes and retry (the SDK backs off exponentially on 5xx / 529 automatically). If it persists, check the official announcements and sales@typesafe.ai |
| Client disconnects the MCP with a JSON parse error | Diagnostics leaked into stdout | Revert any change that uses `console.log`. Diagnostics always go through `console.error`. `server.test.ts` detects SDK logs leaking into stdout but not your own `console.log`, so confirm stdout is empty with `node dist/index.js </dev/null \| head` |
| `EPERM` / cache write failure in `npm ci` | Sandbox denies `~/.npm` | `npm_config_cache=$TMPDIR/npm-cache npm ci` |
| `node --test` hangs | Behavior difference of `node --test <dir>` on Node 22 | `npm test` already works around it with `cd dist && node --test`. Use the same form when calling it directly |
| Answers fluctuate every run (large std under `repeat`) | Ambiguous question, overlapping levels, insufficient information in the state | Rewrite following `question-writing.md`, and adjust until the std from `evaluate_many` is below 0.05 |
| High confidence but wrong | Gap between the question's intent and its wording (literal reading) | State the boundary conditions explicitly in the criteria. Re-decide thresholds from accuracy per band |

### 4.1 When a key leak is suspected

1. Revoke that key in the Console and issue a new one.
2. Update `~/.config/tenbin/env` (or the environment variable and the `claude mcp add -e` registration) and restart the client.
3. Check the repository history with `git log -p -S "sk_" --all` (match the key prefix). If it got in, both rewrite the history and revoke the key.
4. Search files where the key might have been pasted, such as records under `.agents/quality/`.

---

## 5. Maintenance

### 5.1 Checks when changing things

| Change | What to run |
|---|---|
| `tenbin/src/**` | `npm test` and `npm run typecheck` (AGENTS.md). Add a regression test in the same directory |
| Rules in `src/lint.ts` | Make the same change in `skills/tenbin/scripts/lint_questions.py`. Confirm the same input fires the same rules |
| `tenbin/resources/*.md` | Sync to the skill side with `skills/tenbin/scripts/sync_resources.sh` |
| `skills/tenbin/templates/*.py` | `python3 -m py_compile`. Against the SDK, verify by running with `httpx2.MockTransport` (no key needed) |
| `templates/questions.ts` | `tsc --strict --noEmit` somewhere `@typesafe-ai/sdk` resolves |
| Defaults in `src/config.ts` | `README.md` (MCP) and the table in §2.5 of this runbook |
| Tool inputs / outputs | `README.md` (MCP), the implementation status note in `docs/03`, `resources/examples/*.json` |

### 5.2 Updating dependencies

```sh
cd tenbin
npm outdated
npm install @typesafe-ai/sdk@latest      # on an SDK update, also check the diff against reference/sdk.md
npm test && npm run typecheck
```

On a major SDK update, first check the error classes in `src/client.ts` (`AuthenticationError`, etc.) and the shape of `withResponse()`.

### 5.3 Model updates (jev-1.x)

1. Check the new version and what `jev-latest` points to with `tenbin_list_models`.
2. Re-run the calibrated question set on the new version as in §3.2 and compare accuracy per band.
3. If the difference is acceptable, restore `TYPESAFE_DEFAULT_MODEL`. If thresholds changed, update the measurement date in the questions file.
4. Check the official `model-jaggedness/` page for updates to the failure-mode list in `tenbin/resources/jaggedness.md` (then `sync_resources.sh`).

### 5.4 Syncing with the official docs

- Index: https://docs.typesafe.ai/llms.txt (append `.md` to a page path for Markdown).
- On changes, update `tenbin/resources/*.md` (then `sync_resources.sh`) or the skill-only files in `skills/tenbin/reference/`, the lint rules if a limit moved, and the map in `docs/01-official-docs-map.md` if a page moved.
- For differences from the official skill https://github.com/typesafe-ai/skills, follow the policy in the "Maintenance" section of the skill README (where they overlap, the official skill is authoritative).

### 5.5 Pre-release checklist

- [ ] `npm test` / `npm run typecheck` pass
- [ ] `git grep -n "sk_\|TYPESAFE_API_KEY=" -- ':!docs' ':!*.md'` finds no actual key value
- [ ] `node_modules/`, `dist/`, `__pycache__/` are not in the diff
- [ ] The MCP README's tool table and environment-variable table match `src/`
- [ ] The implementation status note in `docs/03` matches reality
- [ ] Conventional Commits (`feat(mcp): ...` / `feat(skill): ...` / `docs: ...`), no attribution lines

---

## 6. Contacts and references

| Use | Location |
|---|---|
| API specification | https://docs.typesafe.ai/api (map: [docs/01](01-official-docs-map.md)) |
| Key management | https://console.typesafe.ai/settings/keys |
| Playground (try questions by hand) | https://console.typesafe.ai/playground |
| Raising rate limits | sales@typesafe.ai |
| Design rationale | [docs/03](03-mcp-server-and-skill-design.md), review record `.agents/quality/findings-2026-09-18-mcp-fixes.md` |
