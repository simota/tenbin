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
]);

export const questionsSchema = z.record(z.string(), questionSchema).describe("Map of question id -> question. Mix types freely; all are evaluated in parallel against the same state.");

export const stateSchema = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe("Content to evaluate: a string, a JSON object (preferred; name each part), or an array.");

