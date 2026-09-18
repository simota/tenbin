import { test } from "node:test";
import assert from "node:assert/strict";
import { lintQuestions, resolvePath } from "./lint.js";
import type { Questions } from "./types.js";

const rules = (r: ReturnType<typeof lintQuestions>) => [...r.errors, ...r.warnings, ...r.infos].map((f) => f.rule);

test("clean questions produce no errors or warnings", () => {
  const q: Questions = {
    department: { type: "choice", instructions: "Which team should handle this ticket?", criteria: { billing: "Charges", technical: "Bugs", other: null } },
    frustration: { type: "score", instructions: "How frustrated is the customer?", criteria: ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"] },
    is_urgent: { type: "noul", instructions: "Does the message convey urgency or time-sensitivity?" },
  };
  const r = lintQuestions(q, "My card was charged twice.");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("numeric-only levels and degree words are flagged", () => {
  const r = lintQuestions({
    a: { type: "score", instructions: "Rate severity from 0 to 2, where 2 is worst", criteria: ["0", "1", "2"] },
    b: { type: "score", instructions: "How severe is the reported issue?", criteria: ["low", "medium", "high"] },
  });
  assert.ok(rules(r).includes("numeric_only_levels"));
  assert.ok(rules(r).includes("degree_words_in_levels"));
  assert.equal(r.errors.length, 0);
});

test("level and option counts are errors", () => {
  const r = lintQuestions({
    one: { type: "score", instructions: "How severe is the reported issue?", criteria: ["only one"] },
    many: { type: "score", instructions: "How severe is the reported issue?", criteria: Array.from({ length: 11 }, (_, i) => `level ${i} situation`) },
    empty: { type: "choice", instructions: "Which team should handle this ticket?", criteria: {} },
  });
  assert.equal(r.errors.filter((f) => f.rule === "score_levels_range").length, 2);
  assert.equal(r.errors.filter((f) => f.rule === "choice_options_range").length, 1);
});

test("inverted noul criteria is a warning, never a blocker", () => {
  const r = lintQuestions({ ok: { type: "noul", instructions: "Is the customer requesting a refund?", criteria: { true: "No refund mentioned", false: "Asks for money back" } } });
  assert.ok(r.warnings.some((f) => f.rule === "noul_criteria_inverted"));
  assert.equal(r.errors.length, 0);
  const legit = lintQuestions({ pii_free: { type: "noul", instructions: "Is the record free of personal information?", criteria: { true: "No personal information is present", false: "Personal information is present" } } });
  assert.equal(legit.errors.length, 0, "a legitimate negative-phrased question is not rejected");
});

test("counting, date comparison, compound and id-only instructions warn", () => {
  const r = lintQuestions({
    n_items: { type: "noul", instructions: "How many items are listed in the order?" },
    overdue: { type: "noul", instructions: "Is the invoice due date before today?" },
    both: { type: "noul", instructions: "Is the customer angry and asking for a refund or a replacement?" },
    refund_requested: { type: "noul", instructions: "Refund?" },
  });
  for (const rule of ["counting_or_math", "date_comparison", "compound_instruction", "id_only_semantics"]) assert.ok(rules(r).includes(rule), rule);
});

test("state paths are resolved against the state", () => {
  const state = { ticket: { messages: [{ text: "hi" }] }, order: { id: "A-1" } };
  assert.equal(resolvePath(state, "ticket.messages[0].text"), true);
  assert.equal(resolvePath(state, "ticket.messages[1].text"), false);
  assert.equal(resolvePath(state, "order.total"), false);
  const r = lintQuestions({ q: { type: "noul", instructions: "Does `ticket.messages[0].text` mention `order.total`?" } }, state);
  assert.equal(r.warnings.filter((f) => f.rule === "state_path_missing").length, 1);
});

test("official structured shapes (Advanced: structure) pass lint", () => {
  // instructions object keys such as `field` resolve against the instructions, not only the state
  const state = { source_text: "Invoice #4471 issued March 3, 2026 to Beaver Dam Logistics, net 30." };
  const r = lintQuestions({
    invoice_number_is_correct: { type: "noul", instructions: { field: { name: "invoice_number", type: "string" }, extracted_value: "4471", question: "Does `extracted_value` match the `field` as it appears in `source_text`?" } },
    payment_terms: { type: "score", instructions: { field: { name: "payment_terms", unit: "days" }, question: "How many days does the `field` in `source_text` allow for payment?" }, criteria: ["Due on receipt", "Net 10", "Net 30", "Net 60", "Net 90"] },
    ok_structured_noul: { type: "noul", instructions: "Is the customer asking for a refund?", criteria: { true: { what: "Asks for money back", examples: ["refund me"] }, false: { what: "No refund mentioned" } } },
  } as unknown as Questions, state);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  // bucketed "how many" on a Score is an info, the same wording on a Noul stays a warning
  assert.ok(r.infos.some((f) => f.rule === "counting_or_math" && f.question_id === "payment_terms"));
  const missing = lintQuestions({ q: { type: "noul", instructions: { question: "Does `extracted_value` match `source_text`?" } } } as unknown as Questions, state);
  assert.equal(missing.warnings.filter((f) => f.rule === "state_path_missing").length, 1, "a key in neither state nor instructions still warns");
  const inverted = lintQuestions({ q: { type: "noul", instructions: "Is the record free of PII?", criteria: { true: { what: "No personal data present" }, false: { what: "Personal data present" } } } } as unknown as Questions);
  assert.ok(inverted.warnings.some((f) => f.rule === "noul_criteria_inverted"), "structured criteria are inspected on their `what` text");
});

test("token budget is enforced", () => {
  const big = "x".repeat(4 * 65_000);
  const r = lintQuestions({ q: { type: "noul", instructions: "Does the document mention a refund?" } }, big);
  assert.ok(r.errors.some((f) => f.rule === "token_budget"));
});

test("date_comparison needs a date-like object after before/after", () => {
  const ok = lintQuestions({ q: { type: "noul", instructions: "Has the customer contacted support about this before?" } });
  assert.ok(!ok.warnings.some((f) => f.rule === "date_comparison"));
  const bad = lintQuestions({ q: { type: "noul", instructions: "Was the invoice issued before 2026-01-01?" } });
  assert.ok(bad.warnings.some((f) => f.rule === "date_comparison"));
});
