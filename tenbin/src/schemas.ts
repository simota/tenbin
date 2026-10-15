import { z } from "zod";

export const entryType = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()]);

const instructions = entryType.describe("The complete question. Question ids are NOT sent to the model.");

export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions,
    criteria: z.object({ true: entryType.optional(), false: entryType.optional() }).nullable().optional().describe("Optional descriptions of what yes and no mean"),
  }),
  z.object({
    type: z.literal("choice"),
    instructions,
    criteria: z.record(z.string(), entryType).describe("Map option -> description | null (1–255 options)"),
  }),
  z.object({
    type: z.literal("score"),
    instructions,
    criteria: z.array(entryType).describe("Ordered array of 2–10 level descriptions, low to high"),
  }),
  // strict: Box takes no criteria, and silently dropping one would hide the mistake.
  z.object({
    type: z.literal("box"),
    instructions: instructions.describe("What to find and in which image, e.g. \"the coffee mug in `photo`\". Needs model jev-preview (Jev 1.14). Experimental."),
  }).strict(),
]);

export const questionsSchema = z.record(z.string(), questionSchema).describe("Map of question id -> question. Mix types freely; all are evaluated in parallel against the same state.");

export const assetsSchema = z
  .record(z.string().min(1), z.object({ path: z.string().min(1).describe("Absolute path of a PNG or JPEG file") }).strict())
  .describe("Images (experimental): reference -> {path}. Write the reference where the image belongs in state, instructions or criteria, e.g. state {\"photo\": \"<photo>\"} with assets {\"<photo>\": {\"path\": \"/abs/door.jpg\"}}. Use delimited references such as <photo> or a UUID; they match as plain text. 256–1568 px per side, upright pixels (EXIF orientation is not applied).");

export const stateSchema = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe("Content to evaluate: a string, a JSON object (preferred; name each part), or an array.");

