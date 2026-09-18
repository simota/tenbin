# Jev 1.13 failure modes and what to do instead

Applies to `jev-1.13`. Official page last reviewed 2026-09-17 (https://docs.typesafe.ai/model-jaggedness/jev-1.13).

| # | failure mode | do this instead |
|---|---|---|
| 1 | Literal reading: answers the words written, not the intent; scoping words, negations, implied conditions taken at face value | state the exact condition; put boundary cases in criteria; split interpretation into two literal questions and combine in code |
| 2 | Math and numbers: cannot count (characters, occurrences, items), weak on hex/RGB, assembly; score positions are not numerically precise | count in code (one Noul per item, sum in code); convert in code and pass named buckets; use score only for thresholds |
| 3 | Date and time comparison: reads dates as text | extract parts with Choice (month/day/year with a "not stated" option), compare in code |
| 4 | Indirection: double negatives, property-of-a-property, multi-hop | write directly; name the state part |
| 5 | Large state with irrelevant detail: accuracy drops (context rot) | filter in code first; if not possible, a Noul relevance filter per part |
| 6 | Adversarial content: injected instructions can move the answer | explicit criteria; test edge cases before deploying |
| 7 | Contradictory instructions and criteria (e.g. Noul true = "no") | align criteria with instructions; high noul must mean yes |
| 8 | Structural invariants: outputs are consistent for similar inputs, but identities between *separate* questions do not hold. Same yes/no as Noul vs 2-option Choice: noul 0.22 vs yes 0.01 / no 0.99 (confidence 0.97). A question and its negation as two Nouls: 0.72 + 0.47 = 1.19 | word each question to mean directly what you want; one threshold per question, tuned on that question's output; never carry a Noul threshold to a Choice or enforce arithmetic identities. A Choice is *relative* (which option), a Noul is *absolute* (can be low for all); use both on one shortlist when you need "which" and "whether at all" (skill suggestion cookbook) |
| 9 | Generation: not trained to produce text | bounded answer → Choice over candidates produced by regex / a generative model |

Avoid: asking for something code can compute exactly; hiding several judgments in one question; System-Two tasks; more state than the question needs.

Context limits: 64k tokens for state + all questions; 32k for state + the longest question.

Language: English is the primary training language and where accuracy is best. Other languages, including CJK scripts, are handled but not equally well: test on your own content before relying on Jev for a non-English workload, and watch confidence when routing. Input is text only; pre-process images, audio, video and binaries into text or structured fields in code.
