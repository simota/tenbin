# SDK minimum

Key from `TYPESAFE_API_KEY` (read by the clients). Also read from the environment: `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_LOG_LEVEL` (`debug` logs request bodies unredacted; never in production).

## Python — `typesafe-sdk`, module `typesafe_sdk`

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

with TypeSafeClient() as client:             # AsyncTypeSafeClient for asyncio
    r = client.system_one(
        state={"document": "I was charged twice. Please fix this ASAP."},
        questions={
            "billing": Noul(instructions="Is this ticket about billing?"),
            "tone": Choice(instructions="What is the customer's tone?",
                           criteria={"calm": None, "frustrated": None, "angry": None}),
            "urgency": Score(instructions="How urgent is this ticket?",
                             criteria=["Can wait", "Needs an answer this week", "Needs an answer today"]),
        },
    )

r.nouls["billing"].noul                      # float, P(yes)
r.choices["tone"].choice, r.choices["tone"].confidence, r.choices["tone"].probabilities
r.scores["urgency"].score, r.scores["urgency"].probabilities   # score: float between levels
r.usage.input_tokens, r.request_id           # request id = x-typesafe-request-id
```

Questions can also be plain dicts with a `type` key. Errors: `TypeSafeAPIError` carries
`status`, `body`, `request_id`. Model is chosen on the client (`TypeSafeClient(model="jev-latest")`) or per call (`system_one(..., model="jev-1.13.0")`; JS `SystemOneRequest.model`).

## JavaScript / TypeScript — `@typesafe-ai/sdk`

```ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();          // Node only; never ship the key to a browser
const r = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: {
    billing: noul("Is this ticket about billing?"),
    tone: choice("What is the customer's tone?", { calm: null, frustrated: null, angry: null }),
    urgency: score("How urgent is this ticket?", ["Can wait", "Needs an answer this week", "Needs an answer today"]),
  },
});

r.answers.billing.noul;
r.answers.tone.choice; r.answers.tone.confidence; r.answers.tone.probabilities;
r.answers.urgency.score;
```

`systemOne(...).withResponse()` gives `{ data, response, requestId }`; `RequestOptions`
accepts `signal`, `timeout`, `retry`. Answer types are inferred from the question helpers.

## Naming

Python snake_case (`system_one`, `base_url`), JS camelCase (`systemOne`, `baseURL`);
`usage.input_tokens` and `release_date` stay snake_case in both.

## Limits and price (jev-1.13)

state + all questions ≤ 64k tokens; state + longest question ≤ 32k; Choice ≤ 255 options;
Score 2–10 levels; $0.042 per million input tokens, output free.
