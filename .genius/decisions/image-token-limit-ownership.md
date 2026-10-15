# Image tokens: the API owns the per-call limit, Tenbin stops guessing it

```record
date: 2026-10-15
status: open
default: Keep the local per-call guard and reserve IMAGE_TOKENS_PER_USE (3,300, a guess) per image use; set the constant from one paid measurement.
constraint: The image-token cost is unknown to everyone but the API (docs /images: "We'll be providing guidance on estimating image token usage soon"). Relaxing it — a published formula — dissolves the problem: Tenbin would compute the cost and keep the guard. A constant cannot follow image size, so it either blocks calls the API would accept (10 uses x 3,300 = 33,000 > the 32,000 state + longest-question rule, so the guard refuses the tenth image use whatever its real cost) or protects nothing.
flip: row "who owns the state / the boundary" — the per-call image-token limit check moves from Tenbin's estimate to the API, which already rejects precisely with 400 max_tokens_exceeded (the same reasoning that left size and dimension limits to the API). Image uses add 0 to the pre-call per-call estimate; the session budget still accounts actual usage.input_tokens after each call.
price: An over-context image request costs a round trip and comes back as an error instead of being refused locally; lint's token_budget finding stops covering images; the session budget under-reserves image calls while they are in flight, so a concurrent batch can overshoot it by up to concurrency x one call's image tokens (at $0.042/Mtok, cents). Whether a rejected 400 is billed is undocumented.
refute_by: TypeSafe publishes an image-token estimate (the "guidance ... soon" sentence leaves /images), making a local exact check possible; or a real over-context image request is billed or fails with something other than a clean 400 max_tokens_exceeded.
refute_cmd: page=$(curl -fsSL --max-time 20 https://docs.typesafe.ai/images.md) || exit 125; printf '%s' "$page" | grep -q '^# Images' || exit 125; if printf '%s' "$page" | grep -q 'estimating image token usage soon'; then exit 0; else exit 3; fi
refute_when: exit 3
evaluate_on: 2026-12-15
tier: local
owner: simota (accepted 2026-10-15 by "Next"; proposed by the agent)
```

Fallback: the default. Retreat restores the constant and the image term in `tokens.ts` and
`lint_questions.py` from 3e01c93; nothing else depends on the flip.

Candidates not taken:
- Learn the reservation from observed `usage.input_tokens` per session (row "when the work
  happens"): the first image call of every session still runs on the guess, and one learned
  number still ignores image size.
- Estimate from pixel dimensions read from the file header (row "representation"): needs a
  tokens-per-pixel rate nobody has published — the default's guessed constant in new words. Struck.

## Log

- 2026-10-15: recorded. Proposed after the image-support implementation (3e01c93), where the
  constant was shipped as provisional. Billing of a rejected 400 is not observable by the command;
  it needs one paid call with TYPESAFE_API_KEY and is checked by a person.
- 2026-10-15: accepted and implemented. IMAGE_TOKENS_PER_USE removed from config.ts and
  lint_questions.py; tokens.ts back to text-only; the 400 hint now explains max_tokens_exceeded.
  Tests: twelve image uses leave the estimate unchanged and raise no token_budget error.
- 2026-10-15: measured with real calls (evaluate.py and the MCP gateway). Image tokens per use
  ~ width x height / 390, identical on jev-1.13.0 and jev-1.14.0 and for PNG and JPEG: 280x280 +202,
  800x600 +1,278, 1568x1176 +4,706 (base 288). The removed 3,300 constant would have under-reserved
  the largest size. Over-context: 6 uses of a 1568x1176 image = 28,571 tokens passed; 7 uses
  returned a clean 400 {"error_type":"max_tokens_exceeded"} (req_01a13fe096a1769984e664703d880402).
  Billing of that 400 is still unobserved (the API returns no usage; needs the console). The
  refutation command has not fired (the "guidance ... soon" sentence is still on /images); the
  empirical rate is unofficial, so the record stays open.
