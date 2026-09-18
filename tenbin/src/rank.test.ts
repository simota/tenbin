import { test } from "node:test";
import assert from "node:assert/strict";
import { batchCandidates, combineRounds } from "./tools/rank.js";

test("combineRounds keeps the final round's order between winners and sums to 1", () => {
  // Reviewer's case: batch 1 winner A at 0.51 among 255, batch 2 is B alone at 1.0, final round A 0.6 / B 0.4.
  const batch1 = Array.from({ length: 255 }, (_, i) => ({ id: i === 0 ? "A" : `x${i}`, content: "" }));
  const batch2 = [{ id: "B", content: "" }];
  const p1 = new Map(batch1.map((c) => [c.id, c.id === "A" ? 0.51 : 0.49 / 254]));
  const p2 = new Map([["B", 1.0]]);
  const out = combineRounds([batch1, batch2], [p1, p2], [batch1[0], batch2[0]], new Map([["A", 0.6], ["B", 0.4]]));
  assert.ok(out.get("A")! > out.get("B")!, "A won the final round and must rank above B");
  assert.ok(out.get("x1")! < out.get("A")!, "a loser stays below its own winner");
  assert.ok(Math.abs(out.get("A")! / out.get("B")! - 1.5) < 1e-9, "the final-round ratio 0.6:0.4 is preserved");
  let total = 0;
  for (const v of out.values()) total += v;
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("batchCandidates grows the longest question with the batch in choice mode", () => {
  const cands = Array.from({ length: 255 }, (_, i) => ({ id: `id${i}`, content: "c" }));
  const per = () => ({ state: 1, questions: 100 });
  const none = { state: 0, questions: 0, longestQuestion: 0, choiceQuestion: 0 };
  const choice = batchCandidates(cands, none, per, { totalTokens: 1_000_000, stateAndQuestionTokens: 10_000, maxPerBatch: 255, cumulativeQuestion: true });
  const noul = batchCandidates(cands, none, per, { totalTokens: 1_000_000, stateAndQuestionTokens: 10_000, maxPerBatch: 255, cumulativeQuestion: false });
  assert.ok(choice.length >= 3, `choice mode must split once the cumulative criteria exceed the limit, got ${choice.length}`);
  assert.equal(noul.length, 1);
});

test("batchCandidates counts shared questions once against the 32k rule", () => {
  const cands = [{ id: "a", content: "a" }, { id: "b", content: "b" }];
  const shared = { state: 25_000, questions: 2_000, longestQuestion: 2_000, choiceQuestion: 0 };
  const batches = batchCandidates(cands, shared, () => ({ state: 10, questions: 20 }), { totalTokens: 57_600, stateAndQuestionTokens: 28_800, maxPerBatch: 255, cumulativeQuestion: false });
  assert.equal(batches.length, 1, "25k state + 2k question fits under 28.8k; shared questions must not be added to the state side");
});

test("choice mode adds candidate increments only to the choice question, then takes the max with existence_check", () => {
  const cands = [{ id: "a", content: "a" }, { id: "b", content: "b" }];
  // state 24k, existence_check 4.5k (the longest), choice question base 30, each candidate adds 256 to the choice question
  const shared = { state: 24_000, questions: 4_530, longestQuestion: 4_500, choiceQuestion: 30 };
  const batches = batchCandidates(cands, shared, () => ({ state: 10, questions: 256 }), { totalTokens: 57_600, stateAndQuestionTokens: 28_800, maxPerBatch: 255, cumulativeQuestion: true });
  assert.equal(batches.length, 1, "24k + 4.5k = 28.5k fits; the increments belong to the 30-token choice question, not to existence_check");
});
