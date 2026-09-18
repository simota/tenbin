# Confidence

`confidence` (0–1) summarises how peaked the `probabilities` distribution is. Choice and Score answers carry it; Noul does not (its value is the signal). It is a convenience statistic; compute your own from `probabilities` if a different measure fits better.

- Low confidence on a Choice: no option is a clear winner.
- Low confidence on a Score: levels overlap, the question measures several things, or the state lacks the information.
- confidence 1.0 means all probability sits on one option. It describes the answer's shape, not that the answer is correct. Calibration is a property of many predictions, not one.

## Three ranges
| range | behaviour |
|---|---|
| high | act automatically |
| medium | proceed with caution: confirm with the user, flag for review, gather more; if the label sits in a hierarchy, report the parent label (it follows from the narrow one, no second call) |
| low | do not act: route to a human, ask for clarification, fall back to a more expensive reasoning model |

## Thresholds scale with risk
Gate each action at a level matching the cost of being wrong:
```python
if action.confidence < 0.5:            route_to_human()          # genuinely unsure
elif action.choice == "check_balance": show_balance()            # low stakes, recoverable
elif action.choice == "approve_transfer":
    if action.confidence > 0.9: confirm_then_execute()           # high stakes, high confidence
    else:                       ask_user_to_confirm()            # high stakes, moderate confidence
```
Start conservative, test on your own labelled data (plot confidence vs accuracy), adjust. Keep thresholds and questions in one file.

## Do not
- compare a Noul probability with a Choice confidence, or multiply Choice probabilities by confidence to rebuild a Noul-style number; the primitives are scored independently.
- use a confidence threshold when you only need the best option: take the highest probability.
- reconstruct an exact number from a Score's position between levels; use it for ranking or thresholds, or round to the nearest level when code needs one outcome. The same `score` can come from different distributions (1.0 = all on level 1, or half on 0 and half on 2): read `probabilities` and `confidence` alongside it.
- multiply confidences when several answers build one action (a function call, a date from parts): the action's confidence is the *minimum* of its parts, the least certain judgement.
