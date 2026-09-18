import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkOptions, describeSubtree, groupIntoRequests, pathScore } from "./tools/walk_taxonomy.js";

test("a path with a zero-probability edge scores 0 regardless of depth", () => {
  const b = pathScore({ path: ["B"], node: null, edge_probabilities: [0.2] });
  const c = pathScore({ path: ["C", "..."], node: null, edge_probabilities: [0, ...Array.from({ length: 19 }, () => 1)] });
  assert.equal(c, 0);
  assert.ok(b > c);
  assert.ok(Math.abs(pathScore({ path: [], node: null, edge_probabilities: [0.8, 0.5] }) - Math.sqrt(0.4)) < 1e-12);
  assert.equal(pathScore({ path: ["only", "child"], node: null, edge_probabilities: [] }), 1, "a path made only of single-child levels has no decisions and is the only possible path");
});

test("trimmed subtrees keep {label: null} leaves as sample leaves", () => {
  const group: Record<string, null> = {};
  for (let i = 0; i < 50; i++) group[`leaf${i}`] = null;
  const trimmed = describeSubtree({ group }, 120) as { children: string[]; sample_leaves: string[] };
  assert.deepEqual(trimmed.children, ["group"]);
  assert.equal(trimmed.sample_leaves.length, 20, "null-terminated labels are collected as leaves");
  assert.equal(trimmed.sample_leaves[0], "leaf0");
});

test("trimmed subtrees shrink until they fit the token limit even with long labels", async () => {
  const { estimateTokens } = await import("./tokens.js");
  const leaves: Record<string, null> = {};
  for (let i = 0; i < 100; i++) leaves[`${"label-".repeat(16)}${i}`] = null;
  for (const limit of [400, 50]) {
    const trimmed = describeSubtree(leaves, limit);
    assert.ok(estimateTokens(trimmed) <= limit, `limit ${limit}: got ${estimateTokens(trimmed)} tokens`);
  }
});

test("chunkOptions respects the option cap and the token budget", () => {
  const opts = Array.from({ length: 600 }, (_, i) => ({ id: `o${i}`, description: null }));
  assert.deepEqual(chunkOptions(opts, 255, 1_000_000).map((c) => c.length), [255, 255, 90]);
  const big = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, description: "d".repeat(400) }));
  assert.ok(chunkOptions(big, 255, 300).length >= 4, "≈100-token options split under a 300-token budget");
});

test("groupIntoRequests keeps each request under both limits", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ key: `q${i}`, question: { type: "noul" as const, instructions: "x" }, tokens: 3_000 }));
  const groups = groupIntoRequests(items, 20_000, 30_000, 28_800);
  for (const g of groups) {
    const sum = g.reduce((a, it) => a + it.tokens, 0);
    assert.ok(20_000 + sum <= 30_000);
  }
  assert.equal(groups.flat().length, 10);
});
