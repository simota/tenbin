# TypeSafe primitives (Choice / Score / Noul)

Jev (System One model) evaluates typed *questions* against a *state* and returns typed answers with calibrated probabilities. No text generation.

| Type | Answers | Returns |
|---|---|---|
| choice | which one of these options? | `choice`, `probabilities` (sum 1), `confidence` |
| score | which level on this ordered scale? | `score` (probability-weighted position, may fall between levels), `legend`, `probabilities`, `confidence` |
| noul | is this true? | `noul` (P(yes), 0–1). No separate confidence |

## Request shape
```json
{"state": <string|object|array>, "model": "jev-latest", "questions": {"<id>": {"type": "...", "instructions": <EntryType>, "criteria": ...}}}
```
- `instructions`, choice option descriptions, score levels and noul `{true,false}` all accept string | object | array | null.
- Question ids are NOT sent to the model. Write the complete question in `instructions`.
- Point at parts of an object state with backticked paths: "Does `ticket.messages[0].text` request a refund?"

## Choosing a type
- choice: fixed set of unordered options (team, category, language). Add `other`/`none of the above` when the list may not cover every input. Up to 255 options; give the full list, not a shortlist.
  Choice probabilities always sum to 1, so some option ranks first even when nothing fits: `other` competes inside that sum, whereas a separate Noul ("does the text answer the query at all?") is absolute and can be low for every option. Use the Choice for *which* and the Noul for *whether* (semantic find, skill suggestion cookbooks).
- score: position on a spectrum you can describe in steps (severity, frustration, skill). 2–10 levels. Describe *situations*, not degrees ("Broken feature, but a workaround exists", not "moderately severe"). One dimension per Score.
- noul: clean yes/no where the probability is the signal. 0.5 means "yes and no equally likely", not "medium".
- Prefer the type your code can act on directly: choice → code paths, score → threshold, noul → `if`.

## Ask everything in one request
All questions in a request see the same state and are evaluated in parallel and independently. Extra questions cost only their tokens and almost no latency. Include speculative questions (ones that only matter for some inputs) and let code ignore the irrelevant answers. Split a complex judgment into one question per factor and combine with weights in code. Make a second request only when the first answer is needed to *build* the second request (fetch more data, pick the next options).

## Limits (jev-1.13)
- state + all questions ≤ 64k tokens; state + longest question ≤ 32k tokens
- text only: pre-process images, audio, video and binaries into text or structured fields before sending
- English is the primary training language; other languages incl. CJK are accepted with lower accuracy — measure on your own data, watch confidence
- price $0.042 per million input tokens; output free
