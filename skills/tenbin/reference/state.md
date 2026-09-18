# Designing the state

The state is the material you hand to the model before asking the questions. Sources: official
State, How to build, Jaggedness, Models pages and the cookbooks named below.

## Rules

1. **Only what the questions need.** Unrelated content is a distractor: accuracy falls as the
   state grows and a wrong answer becomes hard to trace. Retrieve and filter in code first. If
   filtering is impossible, add one Noul per part ("is `passages[3]` relevant to `query`?") and
   keep only the relevant parts for the real questions (classifying RAG passages cookbook).
2. **An object with descriptive names.** A string is fine for one piece of text; otherwise use an
   object so every part is named and the relationships are visible. Put things the decision must
   *compare* in the same state (conversation + order + policy), not in separate calls.
3. **Point questions at parts with backticked paths.** "Does `ticket.messages[0].text` ask for a
   refund?" Paths must exist in the state (lint checks this); with structured instructions a path
   may also name a key of the instructions object (`field`, `extracted_value`).
4. **Content in the state, judgment in the questions.** Policies, reference material and facts go
   in the state; what counts as a match goes in `criteria`. Do not paste rules into the text and
   hope the model applies them: give them a named field and ask about it.
5. **Do not rely on model knowledge for current facts.** The refund policy, the list of sensitive
   credential words, the product catalogue: pass them explicitly, from your own data.
6. **Deterministic work stays in code, before and after the call.**
   - Skip the call when code already knows the answer (a closed ticket → `no_action`).
   - Compute numbers, dates and counts in code and pass the result, or a named bucket.
   - Enumerate candidates in code (regex for emails, amounts, dates; BM25 shortlist; taxonomy
     children) and put them in the state so the model *selects* instead of generating.
7. **Text only, English best.** Convert images, audio, video and binaries to text or structured
   fields. Non-English state (including Japanese) is accepted with lower accuracy: measure on
   your own rows and lean on confidence when routing.
8. **Limits and repeat runs.** State + all questions ≤ 64k tokens, state + longest question ≤ 32k
   (≈ 150k English characters). Estimate with `scripts/estimate_cost.py`. For repeated
   evaluations of the same state add a distinct `sample_uid` field so runs are independent
   trials (`tenbin_evaluate_many` and `scripts/evaluate.py --repeat` do this).

## Shape

```json
{
  "ticket":   {"message": "...", "sender": "a@b.com", "links": ["https://..."]},
  "customer": {"plan": "pro", "open_orders": [{"id": "A-104", "status": "shipped"}]},
  "policy":   {"sensitive_credentials": ["password", "security code", "API key"]}
}
```

Built in code from the raw records: `open_orders` is already filtered to non-delivered orders,
closed tickets never reach this point, and nothing the questions do not reference is included.

## Checks before sending

- Every field is referenced by at least one question; remove the rest (lint warns `state_field_unused`
  once any question uses a backticked path).
- Every backticked path resolves (`tenbin_lint_questions` / `scripts/lint_questions.py --state`).
- Fields the model must never see are named in `forbidden` (tool) / `--forbidden` (script); a match
  is a lint error (`state_path_forbidden`).
- Nothing in the state asks the model to compute, count or compare dates.
- Injected instructions inside user-supplied text cannot change the criteria: criteria are
  explicit, and adversarial rows are in the labelled test set.
