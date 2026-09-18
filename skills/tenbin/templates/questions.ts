/**
 * All TypeSafe questions, weights and thresholds for <feature> in one file.
 * Edit here only. A threshold without a dataset line is provisional.
 */
import { choice, noul, score } from "@typesafe-ai/sdk";

export const MODEL = "jev-latest";

export const QUESTIONS = {
  category: choice("What is this support message about?", {
    bug_report: "Something in the product behaves wrongly",
    billing: "Charges, invoices, refunds, payment methods",
    feature_request: "Asks for something the product does not do",
    other: "None of the above",
  }),
  bugSeverity: score("If the message reports a bug, how severe is it?", [
    "Cosmetic or wording issue",
    "Broken feature, but a workaround exists",
    "Broken feature with no workaround",
    "Data loss, security exposure or the product is unusable",
  ]),
  hasReproSteps: noul("The message contains steps that would let an engineer reproduce the problem"),
  refundRequested: noul("The customer asks for money back"),
  frustration: score("How frustrated is the customer?", [
    "Calm, states facts",
    "Frustrated but civil",
    "Very angry, strong language or threatens to leave",
    "Abusive or threatening",
  ]),
} as const;

// measured: <dataset>, <n rows>, <date>; band accuracy from templates/eval_thresholds.py
export const THRESHOLDS = {
  categoryAuto: 0.75, // provisional
  categoryConfirm: 0.5, // provisional
  severityEscalate: 1.5, // score position; level 2 = no workaround
  reproPresent: 0.6, // provisional
  refundLikely: 0.7, // provisional
  frustrationFlag: 1.5, // provisional
} as const;

export const PRIORITY_WEIGHTS = { bugSeverity: 0.6, frustration: 0.4 } as const;

type ScoreKey = keyof typeof PRIORITY_WEIGHTS;

export function norm(answers: Record<ScoreKey, { score: number }>, qid: ScoreKey): number {
  return answers[qid].score / (QUESTIONS[qid].criteria.length - 1);
}

export function priority(answers: Record<ScoreKey, { score: number }>): number {
  return (Object.keys(PRIORITY_WEIGHTS) as ScoreKey[]).reduce((sum, qid) => sum + PRIORITY_WEIGHTS[qid] * norm(answers, qid), 0);
}
