# Writing instructions and criteria

The model sees `instructions` and `criteria` and the `state`. It never sees the question id,
your variable names, or your comments.

## Instructions

| do | do not |
|---|---|
| "Does `ticket.messages[0].text` ask for money back?" | "refund_requested" with instructions "refund?" |
| "The message says the customer will stop using the product" | "Is the customer not unlikely to churn?" |
| "Which team should handle this message?" | "Which team should handle this, and is it urgent?" (two judgments) |
| "Is the invoice date stated in the text?" then Choice for month/day/year | "Is the invoice older than 30 days?" (date math) |
| one Noul per candidate item, sum in code | "How many items are damaged?" (counting) |
| "Does `lines[14]` pick up mid-sentence from `lines[13]`?" (the narrowest fact that decides the threshold) | "Are lines 13 and 14 part of the same paragraph?" (a judgement call; 17 blocks came out as 12) |

- State the exact condition; put boundary cases into criteria rather than into the sentence.
- Affirmative phrasing: a high Noul must mean "yes" to the sentence. If you need the negative,
  invert in code (`1 - noul`), not in the wording.
- Scoping words ("only", "except", "unless") are read literally. Split into two literal
  questions and combine in code.
- Backticked paths (`order.items[2].sku`) point the model at the field; the path must exist in
  the state (or, for structured instructions, in the instructions object).

### Structured instructions

`instructions` may be an object or array. Start with a string; add structure when it
separates guidance that would otherwise blur. Field names are yours (not reserved) and the
model sees them, so keep them short and plain. Shapes from the official docs:

```json
{"question": "Which team should handle this?", "focus": "the customer's latest message, not the agent replies"}
{"question": "Is the quoted passage consistent with the claim?", "compare": ["`claim`", "`passage`"], "focus": "numbers and dates"}
{"question": "Does the reply follow the policy?", "inspect": "`reply`", "note": "Refusing politely is allowed"}
{"field": {"name": "payment_terms", "type": "integer", "unit": "days", "description": "Days allowed for payment"},
 "extracted_value": "30", "question": "Does `extracted_value` match the `field` as it appears in `source_text`?"}
```

The `field` + `question` shape drives a whole extraction battery: a Noul that verifies a value,
a Choice that picks one from regex candidates, a Score that buckets a number ("Net 10",
"Net 30", …: the levels are situations the model reads off the text, not arithmetic).

## Choice criteria

- Full list, up to 255. A shortlist hides the right answer; two stages (coarse → fine) if larger.
- `other` / `none_of_the_above` / `not_stated` whenever an input may fit nothing.
- Confusable options get structured descriptions. Field names are yours, keep them short:

```json
"return_policy": {"what": "Whether and how an item can be returned",
                  "not_for": "Progress of a return already sent",
                  "examples": ["Can I return shoes I've worn once?"]},
"return_status": {"what": "Progress of a return already sent",
                  "not_for": "Whether and how an item can be returned",
                  "examples": ["When will my refund be paid?"]}
```

- Option names and descriptions are both sent to the model. Use `null` when the name alone is
  clear; otherwise keep the key short and put the meaning in the description.
- Choice always picks something. For "is the argument even given?" send a companion Noul
  (`stated`) and read the Choice only when it says yes; a Choice alone would name some option
  confidently (function calling cookbook). Regex-found candidates get a `none` option
  ("None of these is the requested value.").
- Taxonomy walk: option values are the subtrees, so the model sees what is under each branch;
  trim large branches to direct children plus a sample of leaves.

## Score criteria

Ordered list, index 0 = lowest. 2–10 levels, one dimension.

| works | fails |
|---|---|
| `["Calm, states facts", "Frustrated but civil", "Very angry, strong language", "Abusive or threatening"]` | `["low", "medium", "high"]` (degrees) |
| `["Cosmetic issue", "Broken feature, workaround exists", "Broken feature, no workaround", "Data loss or security"]` | `["0", "1", "2", "3"]` (numbers only; measured: conf 0.35 vs 1.0) |
| one Score for `punctual`, one for `experienced` | `["not punctual and inexperienced", ..., "punctual and experienced"]` (two dimensions) |

- Use as many levels as you can describe distinctly; three is fine.
- Extreme cases that need special handling get their own top level.
- `score` is the probability-weighted position and can fall between levels. Use it for
  thresholds and ranking, or round to the nearest level when code needs one outcome; never as
  a measurement. The same score can come from different distributions: read `probabilities`
  and `confidence` alongside it.
- Levels can be actions: a 3-level Score `merge / curator / unlinked` removes the threshold
  (entity alignment cookbook).

### Structured levels

When the model keeps landing between two neighbouring levels on inputs you find clear, give
each level an object with the same field names (`what`, `examples` or `signals`):

```json
[{"what": "Cosmetic; no impact to functionality", "examples": ["typo in a label", "misaligned icon"]},
 {"what": "Broken or degraded feature, but workaround exists", "examples": ["export fails in one browser but works in another"]},
 {"what": "Blocking issue; no workaround exists", "examples": ["cannot log in", "data loss"]}]
```

Measured on the official example: score 1.12 / confidence 0.81 → 1.06 / 0.91. Examples help
only when they look like your real inputs; unrelated examples change little, and higher
confidence does not establish correctness. Pick examples with known expected levels, then test
on separate inputs.

## Noul criteria

Optional `{"true": ..., "false": ...}` describing what each side looks like. Keep `true`
aligned with the affirmative reading of the instructions; a `true` that starts with "not" or
"no" is a sign the question is inverted. Each side may be an object (`{"what", "examples",
"not_for"}`) when the boundary needs examples.

## Adversarial and noisy input

- Injected instructions inside the state can move an answer. Make criteria explicit and test
  the edge cases before shipping (`templates/eval_thresholds.py`).
- Large state with irrelevant text lowers accuracy. Filter in code; if you cannot, add a Noul
  relevance question per part and keep only the relevant ones for the real questions.
