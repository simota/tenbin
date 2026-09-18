# Choosing thresholds

`confidence` (Choice, Score) summarises how peaked `probabilities` is. A Noul has no
confidence field; its own value is the signal, and this skill buckets it by distance from 0.5
(`|noul - 0.5| * 2`), a convention of this skill, not of the API. Neither says the answer is correct;
calibration is a property of many predictions. So thresholds are set on data, per action.

## Procedure

1. Collect labelled rows: the state, the expected answer, at least 20 per class. Fewer → say
   the bands are unreliable and mark thresholds provisional.
2. Run every row through the same questions (`tenbin_evaluate_many`, or
   `templates/eval_thresholds.py`). Use `repeat` ≥ 2 if repeatability matters; Choice
   probability std is typically ≈ 0.01, so wide swings mean the question is ambiguous.
3. Bucket rows by confidence (Choice/Score) or `|noul - 0.5|` (Noul) into at least 5 bands.
   For each band: row count, accuracy, share of all rows.
4. Choose the boundaries per action from the table:

| band | behaviour | choose the boundary so that |
|---|---|---|
| high | act automatically | accuracy in the band meets what a wrong action costs |
| medium | confirm / flag / gather more | the remaining error is caught by the confirm step |
| low | do not act: human, clarification, fallback | everything else |

5. Report the automation rate each boundary implies (share of rows in the high band) so the
   user sees the trade-off.
6. Put the numbers next to the questions in one file, with the date and the dataset size.

## Different actions, different thresholds

```python
if intent.confidence < 0.6:              # floor: unsure → human
    route_to_support(account_id)
elif intent.choice == "check_balance":   # low stakes, 0.6 is enough
    show_balance(account_id)
elif intent.choice == "approve_transfer":
    if intent.confidence > 0.85:         # high stakes, high confidence
        approve_transfer(account_id)
    else:
        ask_user_to_confirm(account_id)
```

## One threshold per context code can read
When a deterministic feature changes what the same probability means, branch on it in code
first and keep a threshold per branch. Autoformat cookbook: "continues the sentence" is gated
at 0.2 after a dangling line and 0.5 after terminal punctuation; no single number works for
both, and once code checks the punctuation the two bands separate cleanly.

## Several Nouls, one decision
Fixed order, first match wins: security gates first, contradiction before evidence, then the
rest. Each gate has its own threshold; the order is policy, not data.

## When not to threshold

- Only the best option is needed and any choice is harmless → take `max(probabilities)`, no
  confidence check.
- A statistical downstream step exists (rerank, beam search, weighted sum) → feed it
  `probabilities`, not a boolean.
- Three-way outcomes (merge / curator / unlinked) → a 3-level Score removes the threshold.

## Do not

- compare a Noul probability with a Choice confidence
- multiply Choice probabilities by confidence
- multiply confidences of the parts of one action; take the minimum
- carry a threshold tuned on one question to another (Noul → Choice, or across models)
- read an exact number out of a Score position
- gate every action at the same number
- copy a threshold from a cookbook as if it were measured on this data
