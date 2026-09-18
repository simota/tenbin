# Quality review — typesafe-mcp-server fix diff (2026-09-18)

Scope: changes made to address the 8 coding-review findings (src/pool.ts, client.ts, tools/rank.ts,
tools/evaluate_many.ts, tools/evaluate.ts, tools/walk_taxonomy.ts, config.ts, tools/misc.ts, lint.ts,
server.ts, README.md, tests). Excluded: unchanged original code, resources/*.md, prompts.ts.
Method: INTENT (fix the 8 findings) → SCOPE (untracked tree; no git diff available, files re-read in full)
→ AXES → ABSENCE → GRADE. Checks run: `npm test` (23/23, E3 same-author oracle; fake API is also
same-author), SDK/MCP symbol resolution against installed d.ts (E1). Skipped deliberately: live API (no key),
mutation/property testing.

## Findings (root causes)

### F1 — LOW, non-blocking — cancelled in-flight requests are reported as failures
CLAIM:    An `evaluate_many` request that is in flight when the client cancels is counted in
          `summary.failures`, not `summary.cancelled`.
EVIDENCE: E1 + reachable input — src/client.ts:110-127 `describeError` has no `APIUserAbortError` branch;
          the SDK rejects an aborted request with that error (node_modules/@typesafe-ai/sdk/dist/index.mjs:121-132,
          459-469); the MCP SDK aborts `extra.signal` on `notifications/cancelled`
          (node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:27,314-319).
          src/tools/evaluate_many.ts:97-99 turns every throw into an `error` row; :108 counts only unscheduled jobs.
FAILURE:  cancel a 100-state batch with 8 in flight → `cancelled: 92`, `failures: 8` with an abort message;
          an agent reading `failures` retries or reports an API problem that did not happen.
IF WRONG: run evaluate_many with an AbortController aborted after the first fetch starts; if those rows land in
          `cancelled`, this is refuted.
Directive: add an `APIUserAbortError` branch to `describeError` and count aborted rows as cancelled.

### F2 — NIT — `withSampleUid` silently overwrites a caller-supplied `sample_uid`
EVIDENCE: E1 — src/tools/evaluate_many.ts:79 spreads then sets `sample_uid`.
FAILURE:  only if the agent already uses that key in its state; no ordinary input reaches it.
Directive: none required; document or pick a less collidable key if it ever matters.

### F3 — NIT — `rank` has no per-call `concurrency` override, `evaluate_many` does
EVIDENCE: E1 — src/tools/rank.ts:56 takes config concurrency only; src/tools/evaluate_many.ts:13 accepts an override.
Directive: consistency only.

### H1 — HYPOTHESIS (below floor) — choice-mode finale with ≥256 batches would exceed the option cap
src/tools/rank.ts:117-118 builds one Choice over all batch winners. Reaching 256 batches needs ≥256 candidates
of ~28k tokens each (≈$0.3 per run), so no ordinary input was named. Command to settle:
`batchCandidates(256 × 110k-char candidates)` then observe the finale request's option count.

## Adjudication of the previous coding-review findings (this diff's intent)
| # | finding | outcome | evidence |
|---|---|---|---|
| 1 | repeat>1 wrapped state broke paths | real | E3 test "repeat keeps object state paths intact" (fake body inspected) |
| 2 | choice multi-batch ordering | real | E3 property test (own-batch winner never outranked; finale order) |
| 3 | 32k rule unenforced | real | E3 test batches split under 32k; gateway rejects |
| 4 | rank unbounded concurrency | real | E3 test peak in-flight ≤ 2 with TYPESAFE_MCP_CONCURRENCY=2 |
| 5 | budget overshoot in flight | real | E3 test second concurrent call rejected |
| 6 | cancellation ignored | accepted | E3 pool abort test; end-to-end cancel not executed (see F1) |
| 7 | pricing duplicated / dead flag | accepted | E1 grep: single constant, no `logBodies` |
| 8 | date regex false positive | real | E3 lint test |
Counts: real 6 · refuted 0 · accepted 2 · moot 0 · open 0 → real/(real+refuted) = 6/6 over 8 findings, single
reviewer, same session as author (independence caveat applies to both review and tests).

## Independence note
Code and tests come from the same session; the suite proves the code does what the author meant. The
ordering property in test 19 and the concurrency measurement in test 21 are the two oracles not derived from
reading the implementation. A live-API run is the cheapest independent check still missing.

Status: DONE — no blocking finding. Sweep: 4 claims / 4 at floor (F1–F3 E1+input, H1 labelled hypothesis).

## Outcomes after fix (same session)
- F1: fixed — `isCancellation` / `APIUserAbortError` branch in src/client.ts; evaluate_many marks aborted rows `cancelled` and passes the signal to the pool. E3: test "counts in-flight requests aborted by the client as cancelled" (handler invoked directly with an AbortController; 24/24 pass).
- F3: fixed — `rank` accepts a per-call `concurrency` override.
- F2, H1: open (accepted as-is).

## External review round (8 findings) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| P1 | SDK logger could write bodies to stdout under TYPESAFE_LOG_LEVEL | real | logger pinned to stderr, level warn (src/client.ts); E3 test spies console with env=debug |
| P2 | walk_taxonomy duplicates finished paths | real | beam partitioned per level; E3 test {A,B} → [A],[B] |
| P2 | choice scores did not sum to 1 | real | joint P(batch)×P(c|batch); E3 sum≈1 assertions |
| P2 | final round not size-limited | real | recursive rankChoice splits winners; E3 40×20k-char test |
| P2 | batch estimate ignored generated criteria / existence_check | real | perCandidate estimates the generated question; E3 3,000-char criteria test |
| P2 | pool kept scheduling after a failure | real | pool stops on first error and rethrows; E3 pool + rank 1,200-candidate tests |
| P2 | inverted-criteria heuristic blocked legitimate Nouls | real | downgraded to warning; E3 lint test with "free of personal information" |
| P2 | CSV header unescaped | real | csvCell applied to header; E3 "safe,urgent" test |
Counts this round: real 8 · refuted 0 · accepted 0 · moot 0 · open 0 (source: external reviewer, offline reproduction; fixes by the author, same session).

## External review round 2 (7 findings) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| P2 | final-round order inverted by P(batch)×P(c|batch) | real | `combineRounds`: winner keeps final-round probability, losers scaled relative to their winner, normalised; E3 unit test with the reviewer's numbers (A 0.51 / B 1.0 / final 0.6:0.4 → A > B, ratio 1.5) |
| P2 | choice criteria not counted cumulatively in the 32k check | real | `cumulativeQuestion` in batchCandidates; E3 255 × 225-char ids test |
| P2 | strings estimated raw, not JSON-encoded | real | estimateTokens always measures JSON; E3 escape-heavy content test |
| P2 | env could lift the 64k API cap for rank/taxonomy | real | loadConfig caps at API_LIMITS.totalTokens; E3 test with 100000 |
| P2 | `__proto__` candidate id dropped | real | null-prototype criteria dicts (rank, walk_taxonomy); E3 test (fake API fixed to a null-proto dict as well) |
| P2 | histogram read inherited props | real | null-prototype histogram/per maps; E3 "constructor" label test |
| P3 | fractional concurrency accepted | real | intEnv requires a positive integer; E3 test |
Counts this round: real 7 · refuted 0 · accepted 0 · moot 0 · open 0.

## External review round 3 (4 findings) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| P2 | zero-probability edge clamped to 1e-9 let impossible deep paths outrank real ones | real | pathScore returns 0 when any edge ≤ 0; E3 unit test (B 0.2 > C 0×1^19) |
| P2 | one oversized state blocked the whole evaluate_many batch | real | shared questions linted without a state; per-state size handled by the gateway per row; E3 test (short + 128k-char state → 1 ok, 1 failure) |
| P2 | `{label: null}` leaves lost when trimming subtrees | real | leavesOf collects keys with null values; E3 unit test (50 null leaves → 20 samples) |
| P2 | `node --test dist/**/*.test.js` relies on shell glob (fails on Node 20 + /bin/sh) | real | script is now `cd dist && node --test` (default recursive patterns, works on Node 20 and 22; `node --test dist` hangs on 22); E2 `sh -c 'npm test'` 42/42 |
Counts this round: real 4 · refuted 0 · accepted 0 · moot 0 · open 0. Still unverified: Node 20 binary itself, live API.

## External review round 4 (2 findings) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| P2 | rank counted shared questions on the state side and again as the longest question | real | `SharedTokens {state, questions, longestQuestion}` tracked separately in batchCandidates; E3 unit test (25k state + 2k shared question fits) and integration test (100k-char query + 8k existence_check accepted, 1 batch) |
| P2 | evaluate_many kept issuing requests after a batch-wide 401 | real | `isBatchWideError` (401/403/budget) aborts an internal controller → pool stops, rows reported as `skipped` with `stopped_reason`; per-state 422 still partial; E3 tests (30 states / concurrency 1 → 1 request; 422 on one state → 3 requests) |
Counts this round: real 2 · refuted 0 · accepted 0 · moot 0 · open 0.

## External review round 5 (2 findings) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| P2 | BudgetExceededError treated as batch-wide stopped rows that would still fit | real | removed from `isBatchWideError`; budget rejections stay per row; E3 test (budget 30: 80-char row rejected, 1-char row runs, skipped 0) |
| P2 | choice mode added candidate increments to existence_check when it was the longest question | real | `SharedTokens.choiceQuestion` tracked separately; longest = max(existence_check, choice base + increments); E3 unit test (24k + 4.5k fits) and integration test (96k query + 18k existence_check + 1,000-char ids → 1 batch) |
Counts this round: real 2 · refuted 0 · accepted 0 · moot 0 · open 0.

## External review round 6 (2 findings) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| P2 | trimmed subtrees ignored `subtree_token_limit` with long labels | real | describeSubtree halves children/leaf counts until the estimate fits, floor = counts only; E3 unit test (100 × ~100-char leaves at limits 400 and 50) and integration test (20 categories, request accepted) |
| P2 | choice rankChoice rejected sets that the batcher's 0.9 margin split into singletons although they fit the real limits | real | when splitting makes no progress and ≤ 255 candidates, the set is sent as one request and the gateway enforces the real limits; E3 test (2 × 60,000-char candidates → 1 call) |
Counts this round: real 2 · refuted 0 · accepted 0 · moot 0 · open 0.

## Self review round 7 (coding-review on the whole branch) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| 1 | walk_taxonomy sent a level with >255 options or an oversized payload as one Choice | real | per-level `chunkOptions` + `groupIntoRequests`; chunk winners merged with `combineRounds`/`batchWinner` (shared with rank); E3 tests (300 flat options → 2 calls, all ≤255; 200 × 40-leaf categories → every request ≤ 64k) |
| 2 | stale comments (evaluate_many "budget gone"; describeError docblock on the wrong function) | real | fixed |
| 3 | rank split computed twice | real (nit) | computed once |
| 4 | zero-probability options could occupy beam slots | real (nit) | pruned before sorting |
Counts this round: real 4 · refuted 0 · accepted 0 · moot 0 · open 0. H1 from the first review is moot (final rounds split recursively).

## External review round 8 (2 findings) — outcomes
| # | finding | outcome | fix / evidence |
|---|---|---|---|
| P2 | taxonomy chunk budget ignored the instructions and current path | real | fixed question tokens subtracted per path before chunking; E3 test (per-call limit 1000, 200-token instructions, 12 × 120-token options → split, every request ≤ 1000) |
| P2 | a level the margin chunker could not split was rejected although it fit the real limits | real | ≤255 options → sent as one Choice, gateway enforces the real limits; E3 test (28k-token state + 2 × 400-token descriptions → 1 call) |
Counts this round: real 2 · refuted 0 · accepted 0 · moot 0 · open 0.
