# Patterns

| pattern | what | benefit |
|---|---|---|
| Speculative fan-out | send every question the workflow might need in one call, including ones that only matter for some inputs; code picks what is relevant | cost, speed |
| Confidence-gated routing | answer says *what*, confidence says *whether to act*; per-action thresholds by risk | reliability, safety |
| Composite scoring | one Score per dimension, normalise by `len(criteria)-1`, weighted sum in code | cost, reliability |
| Intent routing | classify intent + complexity, route to deterministic code / specialist LLM / human | cost, speed |
| Two-stage (coarse → fine) | cheap broad pass (BM25 shortlist, Choice over all 182 skills, mini model) then a second request on the top few with better evidence. Taxonomy walk: one Choice per level whose option values are the *subtrees* (so the model sees what lives under a branch); if a branch is too large, trim to direct children plus a sample of leaves; beam search over the level probabilities | quality per dollar |
| Verification | decompose "is this correct?" into atomic Nouls, one per field × failure kind (hallucinated, off-target, wrong unit, …). Word each so the *escalate* case is the true case; aggregate with `max` so one confident red flag escalates instead of averaging into silence; empty fields get only an "absence is wrong" question; an overall "is it correct?" Noul is for display, never the gate (SDE cascade cookbook) | observability |
| Guardrail | Nouls per hazard + severity Score on every LLM input and output. Each hazard maps to its own action (jailbreak / policy / harmful → block, medical → review, self-harm → support), a fixed precedence resolves several hits (support > block > review > pass), severity only upgrades a review to a block. The output battery asks the same hazards reworded for a reply ("did the reply give it", `broke_policy` instead of `jailbreak`) (LLM guardrails cookbook) | safety |

## Fan-out + gate skeleton
```python
answers = client.system_one(state=state, questions=QUESTIONS).answers
if answers["category"].confidence < 0.5: return route_to_human()
if answers["category"].choice == "bug_report":
    if answers["bug_severity"].score > 1.5 and answers["has_repro"].noul > 0.6: escalate()
    else: backlog()
elif answers["category"].choice == "billing":
    route_to_billing(refund_likely=answers["refund_requested"].noul > 0.7)
if answers["frustration"].score > 1.5: flag_priority()
```

## Composite skeleton
```python
def norm(qid): return answers[qid].score / (len(QUESTIONS[qid].criteria) - 1)
priority = 0.6 * norm("severity") + 0.3 * norm("frustration") + 0.1 * norm("report_quality")
```

## Several Nouls → one decision: fixed-order gates
Check the gates in a fixed order and take the first that fires. Security decisions come first (prompt injection before anything evidential), contradiction before evidence, and the order is part of the policy, not tuned per input (classifying RAG passages cookbook). Thresholds may differ per gate.

## Combine outputs in code
Weighted sums, first-match gates, or feed probabilities as features into a classical model; without labels, an ensemble of expensive reasoning models can produce them (AutoResearch cookbook). Route on uncertainty to a person *or* to a more expensive reasoning model.

## When two requests are justified
Only when the second request cannot be built without the first answer: fetching more data, deciding what the state is made of, choosing the next options (taxonomy walk). Otherwise ask everything at once.
