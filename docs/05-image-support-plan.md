# Image and Box support: plan

Status: implemented 2026-10-15 (steps 1–4). Superseded on one point the same day: images are no
longer reserved at a guessed `IMAGE_TOKENS_PER_USE`; the API owns the image-token limit
(`.genius/decisions/image-token-limit-ownership.md`). Gateway step 3 and the first risk below
describe the earlier design. Source: docs.typesafe.ai `/images`, `/primitives/box`,
`/models`, JS SDK changelog v0.7.0, the `@typesafe-ai/sdk@0.7.0` tarball.

## Decision

Mirror the API's own model. The MCP tools take an optional `assets` map of
`reference -> { path }`, the same shape as the request's top-level `assets`, and the caller writes
the reference wherever the image belongs in `state`, `instructions` or `criteria`. `box` becomes a
fourth question type. The gateway sends `TypeSafe-Danger-Zone-Images: true` only on calls that
carry an asset or a Box question (decided 2026-10-15: no opt-in flag), and every such result
carries an `experimental` warning.

## Fixed constraints

- `@typesafe-ai/sdk@0.7.0` requires Node.js >= 22 (`package.json` engines) and stops exporting
  payload types. Everything `tenbin/src/client.ts:1-14` imports is still exported (checked
  against `dist/index.d.mts`).
- SDK 0.7 sends any request with images as `multipart/form-data` (`MultipartBody`, first part
  `request`) and compresses bodies >= 1 KiB with zstd by default on Node >= 22.15. The test fake
  fetch parses `JSON.parse(String(init.body))` (`tenbin/src/server.test.ts:21`), which breaks on
  both.
- Images are experimental: format, answers and limits may change between releases.
- `jev-latest` -> 1.13 accepts images; Box needs `jev-preview` / `jev-1.14.0`.
- There is no official image-token estimate yet; image tokens bill as input tokens.
- The server is a local stdio process, so it can read files the agent names.

## Shape

### Types and schemas (`types.ts`, `schemas.ts`)

```ts
interface BoxQuestion { type: "box"; instructions: EntryType }            // no criteria
interface BoxAnswer   { type: "box"; box: { top: number; bottom: number; left: number; right: number }; confidence: number | null }

const assetsSchema = z.record(z.string().min(1), z.object({ path: z.string() }))
  .describe("reference -> absolute path of a PNG/JPEG file; write the reference where the image belongs");
```

`tenbin_evaluate` gains `assets?`. `tenbin_evaluate_many` gains `assets?` (shared, e.g. Choice
example pictures) and `states[].assets?` (per row); the two are merged per row, and a reference
defined in both is an input error.

### Gateway (`client.ts`)

`systemOne(state, questions, model?, signal?, assets?)`:
1. Read each path with `openAsBlob`; reject anything that is not absolute or whose first bytes are
   not the PNG or JPEG signature, before any network call. This is the boundary check that keeps
   the tool from uploading an arbitrary local file.
2. Pass `assets: { ref: image(blob) }` to `client.systemOne` and
   `headers: { "TypeSafe-Danger-Zone-Images": "true" }` when there is an asset or a Box question.
3. Reserve tokens per image use: count each reference's occurrences in the request and add
   `IMAGE_TOKENS_PER_USE` (a provisional constant in `config.ts`, commented as unmeasured) to the
   estimate. Actual `usage.input_tokens` still drives accounting, as today.
4. `describeError`: add hints for 413 (size limits) and 400 on image requests (format, dimensions
   256-1568 px, EXIF not applied, unreferenced asset).

Size, dimensions and pixel limits are not checked locally: the API rejects the whole request with a
precise status, and duplicating its rules would drift when the experimental limits change.

### Lint (`lint.ts`, mirrored in `skills/tenbin/scripts/lint_questions.py`)

| Rule | Severity |
|---|---|
| `box` accepted as a type; `box` with `criteria` | error |
| `box` with no asset in the request | error |
| `box` with an explicit model that is not `jev-preview` / `jev-1.14*` (or default model not one) | error |
| `box` without a Noul in the same request (no "not found" answer exists) | info |
| asset reference never appears in state/instructions/criteria (API returns 400) | error |
| reference over 1,024 bytes, or all references over 65,536 bytes | error |
| reference shorter than 8 characters, or found inside a longer word (accidental match) | warning |
| one reference used in the `instructions` of two or more questions (move it into state) | warning |

The Python lint reads an optional top-level `assets` key from its JSON input so both linters see the
same request.

### Batch summary (`evaluate_many.ts`)

`summarize` gets a `box` branch: `stats()` per edge and for `confidence`.

### Docs

`skills/tenbin/reference/state.md:28` ("Text only") is rewritten: images are allowed, experimental,
with the preparation rules (upright pixels, longest side <= 1568, PNG/JPEG). `primitives.md` gains Box;
`patterns.md` gains the Box + Noul and compare-against-a-known-picture patterns. Run
`scripts/sync_resources.sh`. Update `docs/01-official-docs-map.md`, `docs/03-...`, the runbook and
README/AGENTS for Node 22 and the new inputs.

## Build order

1. **SDK bump, no behaviour change.** `@typesafe-ai/sdk ^0.7.0`, engines `>=22`, Node 22 in docs.
   Teach the fake fetch to decode zstd (`zlib.zstdDecompressSync`) and multipart
   (`new Response(body, { headers }).formData()`). Done when `npm test` and `npm run typecheck`
   pass unchanged.
2. **Box without images.** Types, schema, lint rules (TS and Python), `summarize`. Tests: lint
   findings, schema accepts `box`, summary of fake Box answers.
3. **Assets.** Inputs, gateway reading and signature check, header, token reservation, error hints.
   Tests: fake fetch asserts the multipart parts and the header; header absent on text-only
   calls; non-image file rejected before fetch; unreferenced asset blocked by lint.
4. **Docs and resources.**

Each step is one commit and leaves the suite green.

## Excluded

- `skills/tenbin/scripts/evaluate.py` image sending (next step: base64 assets in JSON, stdlib only).
  Done 2026-10-15: `assets` in the request (shared) and in rows, relative paths resolved against
  the file that names them, base64 in JSON with the images header.
- Images as `tenbin_rank` candidates or `tenbin_walk_taxonomy` items.
- Base64 or URL input to the MCP tools; image resize, rotation or conversion.
- Box confidence thresholds: none are published; they stay unmeasured until run on real images.
- An opt-in flag for images.

## Rejected options

- **Images as MCP image content or base64 arguments.** Large tool arguments go through the
  agent's context window; a path keeps the bytes out of it.
- **A marker convention inside state such as `"image:/path.png"`.** Invents a second reference
  syntax next to the API's; the `assets` map is the API's own shape.
- **Local size/dimension validation.** Needs an image decoder and duplicates experimental limits.

## What would make this wrong

- **Image token cost.** If one image costs far more than `IMAGE_TOKENS_PER_USE`, the per-call
  guard lets oversized calls through (the API then returns `400 max_tokens_exceeded`, which is
  handled) and the session budget under-reserves. Check: one real call with one 1568x1176 JPEG and
  one 280x280 PNG, read `usage.input_tokens`, set the constant from it (cost < $0.01).
- **Header via `RequestOptions.headers`.** Assumed from the SDK docs; step 3's fake-fetch test
  proves it is sent.
- **Path visibility.** If an MCP client runs the server where the agent's paths do not exist
  (remote or containerised), path input fails; the tool then returns the read error per asset.
