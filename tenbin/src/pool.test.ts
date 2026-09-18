import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "./pool.js";

test("pool stops scheduling after abort and leaves later slots empty", async () => {
  const ac = new AbortController();
  const ran: number[] = [];
  const out = await pool([1, 2, 3, 4], 1, async (n) => {
    ran.push(n);
    if (n === 2) ac.abort();
    return n * 10;
  }, ac.signal);
  assert.deepEqual(ran, [1, 2]);
  assert.equal(out[0], 10);
  assert.equal(out[3], undefined);
});

test("pool stops scheduling after the first failure and rethrows it", async () => {
  const ran: number[] = [];
  await assert.rejects(
    pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      ran.push(n);
      await new Promise((r) => setTimeout(r, 1));
      if (n === 1) throw new Error("boom");
      return n;
    }),
    /boom/,
  );
  assert.ok(ran.length <= 3, `expected at most the in-flight items plus one, ran ${ran}`);
});
