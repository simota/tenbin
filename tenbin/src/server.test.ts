import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TypeSafeGateway } from "./client.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { makeEvaluateMany } from "./tools/evaluate_many.js";

/** Fake TypeSafe API: deterministic answers derived from the request. */
function fakeFetch(): { fetch: typeof fetch; calls: { url: string; body: any }[]; maxInflight: () => number } {
  const calls: { url: string; body: any }[] = [];
  let inflight = 0;
  let peak = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-typesafe-request-id": `req-${calls.length}` } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 2));
    inflight -= 1;
    if (url.endsWith("/v1/models")) return json({ models: [{ name: "jev-latest", description: "latest", release_date: "2026-09-01" }] });
    if (!url.endsWith("/v1/systemone")) return json({ error: "not found" }, 404);
    if (String(init?.headers && new Headers(init.headers).get("authorization")) !== "Bearer test-key") return json({ error: "unauthorized" }, 401);
    if (JSON.stringify(body.state).includes("FAIL422")) return json({ error: "invalid", field: "state" }, 422);
    const answers: Record<string, unknown> = {};
    const stateText = JSON.stringify(body.state);
    for (const [id, q] of Object.entries<any>(body.questions)) {
      if (q.type === "noul") {
        const m = /`candidates\[(\d+)\]`/.exec(typeof q.instructions === "string" ? q.instructions : "");
        const relevant = m ? JSON.stringify(body.state.candidates[Number(m[1])]).includes("relevant") : stateText.includes("urgent");
        answers[id] = { type: "noul", noul: relevant ? 0.9 : 0.1 };
      } else if (q.type === "choice") {
        const opts = Object.keys(q.criteria);
        const probabilities: Record<string, number> = Object.create(null);
        const winner = opts.find((o) => new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(stateText)) ?? opts[0];
        for (const o of opts) probabilities[o] = opts.length === 1 ? 1 : o === winner ? 0.7 : 0.3 / (opts.length - 1);
        answers[id] = { type: "choice", choice: winner, confidence: 0.6, probabilities };
      } else {
        const n = q.criteria.length;
        const probabilities: Record<string, number> = {};
        for (let i = 0; i < n; i++) probabilities[String(i)] = i === 1 ? 0.7 : i === n - 1 ? 0.3 : 0;
        const legend: Record<string, unknown> = {};
        q.criteria.forEach((c: unknown, i: number) => (legend[String(i)] = c));
        answers[id] = { type: "score", score: 0.7 + 0.3 * (n - 1), confidence: 0.54, legend, probabilities };
      }
    }
    return json({ model: "jev-1.13.0", answers, usage: { input_tokens: Math.ceil(stateText.length / 4) + 50, output_tokens: 10 } });
  };
  return { fetch: fetchImpl, calls, maxInflight: () => peak };
}

async function connect(env: Record<string, string>) {
  const config = loadConfig({ ...env });
  const fake = fakeFetch();
  const gateway = config.apiKey ? new TypeSafeGateway(config, fake.fetch as never) : null;
  const server = createServer(config, gateway);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, fake, close: () => Promise.all([client.close(), server.close()]) };
}

const KEY = { TYPESAFE_API_KEY: "test-key" };

test("lists 7 tools, 6 guides + example template, 4 prompts", async () => {
  const { client, close } = await connect(KEY);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["tenbin_evaluate", "tenbin_evaluate_many", "tenbin_lint_questions", "tenbin_list_models", "tenbin_rank", "tenbin_session_stats", "tenbin_walk_taxonomy"]);
  const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
  assert.ok(resources.includes("tenbin://guide/primitives"));
  assert.ok(resources.includes("tenbin://guide/suggestions"));
  assert.equal(resources.filter((uri) => uri.startsWith("tenbin://guide/")).length, 6);
  assert.ok(resources.includes("tenbin://examples/triage"));
  const guide = await client.readResource({ uri: "tenbin://guide/jaggedness" });
  assert.match(String((guide.contents[0] as { text: string }).text), /Literal reading/);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ["decompose_judgment", "design_thresholds", "review_typesafe_code", "tenbin"]);
  const p = await client.getPrompt({ name: "decompose_judgment", arguments: { judgment: "route tickets" } });
  assert.match(String((p.messages[0].content as { text: string }).text), /route tickets/);
  await close();
});

test("offline mode exposes the linter, discovery prompt, and resources without API tools", async () => {
  const { client, close } = await connect({});
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(tools, ["tenbin_lint_questions"]);
  assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ["tenbin"]);
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  assert.ok(resources.includes("tenbin://guide/suggestions"));
  assert.ok(resources.includes("tenbin://examples/triage"));
  const example = await client.readResource({ uri: "tenbin://examples/triage" });
  const body = JSON.parse(String((example.contents[0] as { text: string }).text));
  assert.ok(body.state);
  assert.ok(body.questions);
  const r = await client.callTool({ name: "tenbin_lint_questions", arguments: { questions: { sev: { type: "score", instructions: "Rate severity from 0 to 2", criteria: ["0", "1", "2"] } } } });
  const sc = r.structuredContent as { warnings: { rule: string }[] };
  assert.ok(sc.warnings.some((w) => w.rule === "numeric_only_levels"));
  await close();
});

test("tenbin prompt shares the skill guide and opens without arguments or API calls", async (t) => {
  for (const [mode, env] of [["online", KEY], ["offline", {}]] as const) {
    await t.test(mode, async (t) => {
      const { client, fake, close } = await connect(env);
      t.after(close);
      const resource = await client.readResource({ uri: "tenbin://guide/suggestions" });
      const guide = String((resource.contents[0] as { text: string }).text);
      const skillGuide = await readFile(new URL("../../skills/tenbin/reference/suggestions.md", import.meta.url), "utf8");
      assert.equal(guide, skillGuide, "MCP and standalone skill use the same discovery workflow");

      const listed = (await client.listPrompts()).prompts.find((p) => p.name === "tenbin");
      assert.ok(listed);
      assert.equal(listed.arguments, undefined);
      const defaultPrompt = await client.getPrompt({ name: "tenbin" });
      const defaultContent = defaultPrompt.messages[0].content;
      assert.equal(defaultContent.type, "text");
      if (defaultContent.type !== "text") throw new Error("Expected a text prompt");
      assert.ok(defaultContent.text.startsWith(guide), "guide is embedded for prompt-only clients");
      assert.equal(defaultContent.text.includes("This server is offline:"), mode === "offline");

      assert.deepEqual(await client.getPrompt({ name: "tenbin", arguments: {} }), defaultPrompt);
      assert.equal(fake.calls.length, 0, "discovery never calls TypeSafe, even with a configured key");
    });
  }
});

test("evaluate returns answers, cost and request id; lint errors block the call", async () => {
  const { client, fake, close } = await connect(KEY);
  const r = await client.callTool({
    name: "tenbin_evaluate",
    arguments: {
      state: "Help! My payouts have been failing for 3 days. This is urgent. billing",
      questions: {
        department: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments", technical: "Bugs", other: null } },
        frustration: { type: "score", instructions: "How frustrated is the customer?", criteria: ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"] },
        is_urgent: { type: "noul", instructions: "Does the message convey urgency?" },
      },
    },
  });
  assert.equal(r.isError, undefined);
  const sc = r.structuredContent as any;
  assert.equal(sc.answers.department.choice, "billing");
  assert.equal(sc.answers.is_urgent.noul, 0.9);
  assert.equal(sc.request_id, "req-1");
  assert.ok(sc.cost_usd > 0);
  assert.equal(JSON.parse(String((r.content as any)[0].text)).answers.department.choice, "billing", "content text is the same JSON as structuredContent");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body.model, "jev-latest", "SDK fills in the default model");

  const bad = await client.callTool({ name: "tenbin_evaluate", arguments: { state: "x", questions: { s: { type: "score", instructions: "How severe is the issue?", criteria: ["only one level"] } } } });
  assert.equal(bad.isError, true);
  assert.match(String((bad.content as any)[0].text), /score_levels_range|2–10 levels/);
  assert.equal(fake.calls.length, 1, "no API call when lint fails");
  await close();
});

test("evaluate_many aggregates rows and supports repeat", async () => {
  const { client, fake, close } = await connect(KEY);
  const r = await client.callTool({
    name: "tenbin_evaluate_many",
    arguments: {
      states: [{ id: "a", state: "urgent thing" }, { id: "b", state: "calm thing" }],
      questions: { is_urgent: { type: "noul", instructions: "Does the message convey urgency?" } },
      repeat: 2,
    },
  });
  const sc = r.structuredContent as any;
  assert.equal(sc.rows.length, 4);
  assert.equal(sc.summary.per_question.is_urgent.noul.n, 4);
  assert.equal(sc.summary.per_question.is_urgent.noul.mean, 0.5);
  assert.equal(sc.summary.failures.length, 0);
  assert.equal(fake.calls[0].body.state.sample_uid, "a-0");
  assert.equal(JSON.parse(String((r.content as any)[0].text)).rows.length, 4, "content text is the same JSON as structuredContent");
  await close();
});

test("rank orders candidates by noul and batches beyond the option cap", async () => {
  const { client, fake, close } = await connect(KEY);
  const candidates = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, content: i === 42 ? "a relevant passage" : `passage ${i}` }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "which passage is relevant?", candidates, instructions: "Is {candidate} relevant to `query`?", top_k: 3 } });
  const sc = r.structuredContent as any;
  assert.equal(sc.ranked[0].id, "c42");
  assert.equal(sc.ranked[0].score, 0.9);
  assert.equal(sc.batches, 2);
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[0].body.questions.c_0.instructions, /`candidates\[0\]`/);
  await close();
});

test("walk_taxonomy follows the best path and asks one request per level", async () => {
  const { client, fake, close } = await connect(KEY);
  const taxonomy = { "Sporting Goods": { Cycling: ["Bike Bottles", "Helmets"], Fitness: ["Yoga Mats"] }, "Home & Kitchen": { Drinkware: ["Water Bottles"] } };
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "32oz bottle for bike cages. Sporting Goods. Cycling. Bike Bottles", taxonomy, beam_width: 2 } });
  const sc = r.structuredContent as any;
  assert.deepEqual(sc.paths[0].path, ["Sporting Goods", "Cycling", "Bike Bottles"]);
  assert.equal(sc.paths[0].complete, true);
  assert.equal(sc.decisions, 3);
  assert.equal(Object.keys(fake.calls[1].body.questions).length, 1, "the single-child branch (Home & Kitchen > Drinkware) is taken without a question; only Sporting Goods is asked");
  await close();
});

test("walk_taxonomy takes single-child levels without a call and without an edge", async () => {
  const { client, fake, close } = await connect(KEY);
  const taxonomy = { A: { only: { deeper: ["x", "y"] } }, B: null };
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "about A and x", taxonomy, beam_width: 2 } });
  const sc = r.structuredContent as any;
  assert.deepEqual(sc.paths[0].path, ["A", "only", "deeper", "x"]);
  assert.equal(sc.paths[0].edge_probabilities.length, 2, "A/B and x/y are decisions; only→deeper is not");
  assert.equal(sc.decisions, 2);
  assert.equal(fake.calls.length, 2);
  await close();
});

test("session budget blocks calls and stats report usage", async () => {
  const { client, close } = await connect({ ...KEY, TENBIN_SESSION_TOKEN_BUDGET: "70" });
  const q = { is_urgent: { type: "noul", instructions: "Does the message convey urgency?" } };
  const ok = await client.callTool({ name: "tenbin_evaluate", arguments: { state: "urgent", questions: q } });
  assert.equal(ok.isError, undefined);
  const blocked = await client.callTool({ name: "tenbin_evaluate", arguments: { state: "urgent", questions: q } });
  assert.equal(blocked.isError, true);
  assert.match(String((blocked.content as any)[0].text), /session token budget/);
  const stats = (await client.callTool({ name: "tenbin_session_stats", arguments: {} })).structuredContent as any;
  assert.equal(stats.calls, 1);
  assert.equal(stats.input_tokens, 52);
  const models = (await client.callTool({ name: "tenbin_list_models", arguments: {} })).structuredContent as any;
  assert.equal(models.models[0].name, "jev-latest");
  await close();
});

test("401 from the API becomes an actionable error", async () => {
  const { client, close } = await connect({ TYPESAFE_API_KEY: "wrong-key" });
  const r = await client.callTool({ name: "tenbin_evaluate", arguments: { state: "x", questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } } } });
  assert.equal(r.isError, true);
  assert.match(String((r.content as any)[0].text), /TYPESAFE_API_KEY/);
  await close();
});

test("evaluate_many repeat keeps object state paths intact (sample_uid merged, not wrapped)", async () => {
  const { client, fake, close } = await connect(KEY);
  const r = await client.callTool({
    name: "tenbin_evaluate_many",
    arguments: {
      states: [{ id: "a", state: { ticket: { text: "urgent" } } }],
      questions: { is_urgent: { type: "noul", instructions: "Does `ticket.text` convey urgency?" } },
      repeat: 2,
    },
  });
  const sc = r.structuredContent as any;
  assert.ok(!sc.warnings.some((w: string) => w.includes("state_path_missing")), `unexpected warning: ${sc.warnings}`);
  assert.equal(fake.calls[0].body.state.ticket.text, "urgent");
  assert.equal(fake.calls[0].body.state.sample_uid, "a-0");
  assert.equal(fake.calls[1].body.state.sample_uid, "a-1");
  await close();
});

test("rank choice mode across batches: nobody outranks its own batch winner, finalists ranked by the final round", async () => {
  const { client, fake, close } = await connect(KEY);
  const candidates = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, content: i === 42 ? "c42 the relevant one" : `passage number ${i}` }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "which is relevant?", candidates, mode: "choice", instructions: "Which of {candidate} is relevant to `query`?" } });
  const sc = r.structuredContent as any;
  assert.equal(sc.calls, 3, "two batches plus one final round");
  assert.equal(sc.ranked[0].id, "c42");
  assert.equal(sc.ranked[1].id, "c255", "winner of the second batch is second");
  const byId = new Map<string, number>(sc.ranked.map((x: any) => [x.id, x.score] as [string, number]));
  for (let i = 0; i < 255; i++) if (i !== 42) assert.ok(byId.get(`c${i}`)! < byId.get("c42")!);
  for (let i = 256; i < 300; i++) assert.ok(byId.get(`c${i}`)! < byId.get("c255")!);
  assert.ok(byId.get("c1")! < byId.get("c255")!, "a loser of the winning batch stays below the other batch's winner");
  const total = sc.ranked.reduce((a: number, x: any) => a + x.score, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `choice scores sum to 1, got ${total}`);
  assert.equal(fake.calls[2].body.questions.pick.criteria.c42, "`candidates[0]`");
  await close();
});

test("rank splits batches on the 32k state + question rule, not only the 255 cap", async () => {
  const { client, fake, close } = await connect(KEY);
  const candidates = Array.from({ length: 255 }, (_, i) => ({ id: `c${i}`, content: `${i} ` + "w".repeat(600) }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, instructions: "Is {candidate} relevant?" } });
  const sc = r.structuredContent as any;
  assert.ok(sc.batches >= 2, `expected ≥2 batches, got ${sc.batches}`);
  for (const c of fake.calls) assert.ok(JSON.stringify(c.body.state).length / 4 <= 32_000, "each batch state stays under the API limit");
  await close();
});

test("rank honours TENBIN_CONCURRENCY", async () => {
  const { client, fake, close } = await connect({ ...KEY, TENBIN_CONCURRENCY: "2" });
  const candidates = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, content: `p${i}` }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, instructions: "Is {candidate} relevant?" } });
  assert.equal((r.structuredContent as any).batches, 4);
  assert.ok(fake.maxInflight() <= 2, `in-flight peaked at ${fake.maxInflight()}`);
  await close();
});

test("session budget counts calls in flight", async () => {
  const { client, close } = await connect({ ...KEY, TENBIN_CONCURRENCY: "2", TENBIN_SESSION_TOKEN_BUDGET: "30" });
  const r = await client.callTool({
    name: "tenbin_evaluate_many",
    arguments: { states: [{ id: "a", state: "urgent" }, { id: "b", state: "urgent" }], questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } } },
  });
  const sc = r.structuredContent as any;
  assert.equal(sc.summary.failures.length, 1, "second concurrent call is rejected while the first is still reserved");
  assert.match(sc.summary.failures[0].error, /in flight/);
  await close();
});

test("list_models pricing comes from the single configured price", async () => {
  const { client, close } = await connect(KEY);
  const models = (await client.callTool({ name: "tenbin_list_models", arguments: {} })).structuredContent as any;
  assert.equal(models.pricing["jev-1.13.0"].usd_per_mtok_input, 0.042);
  assert.equal(models.pricing["jev-1.13.0"].usd_per_btok_input, 42);
  await close();
});

test("evaluate_many counts in-flight requests aborted by the client as cancelled, not failed", async () => {
  const config = loadConfig({ ...KEY, TENBIN_CONCURRENCY: "2" });
  const fake = fakeFetch();
  const gateway = new TypeSafeGateway(config, fake.fetch as never);
  const handler = makeEvaluateMany(gateway, config.maxTokensPerCall, config.concurrency, config.maxStates);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1);
  const states = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, state: "urgent" }));
  const r = await handler({ states, questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } }, repeat: 1 }, { signal: ac.signal });
  const sc = (r as { structuredContent?: any }).structuredContent;
  assert.ok(sc, "handler returned a result, not an error");
  assert.ok(sc.summary.cancelled > 0, "some jobs were cancelled");
  assert.equal(sc.summary.failures.length, 0, "aborted in-flight requests are not failures");
  assert.equal(sc.rows.length + sc.summary.cancelled, 20);
  assert.ok(fake.calls.length < 20, "scheduling stopped after abort");
});

test("SDK logging never reaches stdout even with TYPESAFE_LOG_LEVEL=debug in the environment", async () => {
  const prev = process.env.TYPESAFE_LOG_LEVEL;
  process.env.TYPESAFE_LOG_LEVEL = "debug";
  const spied: string[] = [];
  const orig = { log: console.log, info: console.info, debug: console.debug };
  console.log = (...a: unknown[]) => { spied.push("log:" + a.join(" ")); };
  console.info = (...a: unknown[]) => { spied.push("info:" + a.join(" ")); };
  console.debug = (...a: unknown[]) => { spied.push("debug:" + a.join(" ")); };
  try {
    const { client, close } = await connect(KEY);
    await client.callTool({ name: "tenbin_evaluate", arguments: { state: "secret body text", questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } } } });
    await close();
  } finally {
    Object.assign(console, orig);
    if (prev === undefined) delete process.env.TYPESAFE_LOG_LEVEL; else process.env.TYPESAFE_LOG_LEVEL = prev;
  }
  assert.deepEqual(spied, []);
});

test("walk_taxonomy reports each finished path once when every path ends before max_depth", async () => {
  const { client, close } = await connect(KEY);
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "something about A", taxonomy: { A: null, B: null }, beam_width: 2 } });
  const sc = r.structuredContent as any;
  assert.deepEqual(sc.paths.map((p: any) => p.path), [["A"], ["B"]]);
  await close();
});

test("rank choice mode splits the final round too when the batch winners do not fit one request", async () => {
  const { client, close } = await connect(KEY);
  const candidates = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, content: (i === 7 ? "c7 relevant " : "") + "w".repeat(20_000) }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, mode: "choice", instructions: "Which of {candidate} is relevant?" } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  const sc = r.structuredContent as any;
  assert.ok(sc.batches >= 8, `expected ≥8 first-round batches, got ${sc.batches}`);
  assert.ok(sc.calls > sc.batches + 1, "the final round itself was split");
  assert.equal(sc.ranked[0].id, "c7");
  const total = sc.ranked.reduce((a: number, x: any) => a + x.score, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `scores sum to 1, got ${total}`);
  await close();
});

test("rank batching accounts for criteria copied into every generated question", async () => {
  const { client, fake, close } = await connect(KEY);
  const candidates = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, content: `p${i}` }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, instructions: "Is {candidate} relevant to `query`?", criteria: { true: "y".repeat(3000), false: "no" } } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  assert.ok((r.structuredContent as any).batches >= 2);
  for (const c of fake.calls) assert.ok(JSON.stringify(c.body).length / 4 <= 60_000);
  await close();
});

test("rank stops issuing batches after the first failure", async () => {
  const { client, fake, close } = await connect({ ...KEY, TENBIN_CONCURRENCY: "2" });
  const candidates = Array.from({ length: 1200 }, (_, i) => ({ id: `c${i}`, content: i === 0 ? "FAIL422" : `p${i}` }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, instructions: "Is {candidate} relevant?" } });
  assert.equal(r.isError, true);
  assert.match(String((r.content as any)[0].text), /422/);
  assert.ok(fake.calls.length <= 2, `expected at most the 2 in-flight requests, saw ${fake.calls.length}`);
  await close();
});

test("rank choice mode splits when the accumulated criteria alone would break the 32k rule", async () => {
  const { client, close } = await connect(KEY);
  const candidates = Array.from({ length: 255 }, (_, i) => ({ id: `https://example.com/${"p".repeat(200)}/${i}`, content: "b".repeat(500) }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, mode: "choice", instructions: "Which of {candidate} matches `query`?" } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  assert.ok((r.structuredContent as any).batches >= 2);
  await close();
});

test("rank estimates candidate strings as JSON, so escape-heavy content still batches under the limit", async () => {
  const { client, close } = await connect(KEY);
  const candidates = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, content: '{"a":"b","c":"d"}\n'.repeat(60) }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, instructions: "Is {candidate} relevant?" } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  await close();
});

test("the API total limit applies even when TENBIN_MAX_TOKENS_PER_CALL is set higher", async () => {
  assert.equal(loadConfig({ ...KEY, TENBIN_MAX_TOKENS_PER_CALL: "100000" }).maxTokensPerCall, 64_000);
  const { client, fake, close } = await connect({ ...KEY, TENBIN_MAX_TOKENS_PER_CALL: "100000" });
  const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, content: `${i} ` + "w".repeat(26_000) }));
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, instructions: "Is {candidate} relevant?" } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  for (const c of fake.calls) assert.ok(JSON.stringify(c.body).length / 4 <= 64_000, "no request above the API limit");
  await close();
});

test("candidate ids such as __proto__ survive as Choice options", async () => {
  const { client, fake, close } = await connect(KEY);
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates: [{ id: "__proto__", content: "__proto__ relevant" }, { id: "b", content: "other" }], mode: "choice", instructions: "Which of {candidate} matches `query`?" } });
  const sc = r.structuredContent as any;
  assert.ok(Object.hasOwn(fake.calls[0].body.questions.pick.criteria, "__proto__"), "option sent to the API");
  assert.equal(sc.ranked[0].id, "__proto__");
  assert.ok(sc.ranked[0].score > 0);
  await close();
});

test("choice histogram counts labels that collide with Object.prototype", async () => {
  const { client, close } = await connect(KEY);
  const r = await client.callTool({
    name: "tenbin_evaluate_many",
    arguments: { states: [{ id: "a", state: "constructor please" }], questions: { pick: { type: "choice", instructions: "Which label fits the message?", criteria: { constructor: null, toString: null, other: null } } } },
  });
  const hist = (r.structuredContent as any).summary.per_question.pick.choice_histogram;
  assert.equal(hist.constructor, 1);
  assert.equal(hist.toString, undefined);
  await close();
});

test("TENBIN_CONCURRENCY rejects non-integers at startup", () => {
  assert.throws(() => loadConfig({ ...KEY, TENBIN_CONCURRENCY: "0.5" }), /positive integer/);
  assert.throws(() => loadConfig({ ...KEY, TENBIN_MAX_STATES: "-3" }), /positive integer/);
  assert.equal(loadConfig({ ...KEY, TENBIN_CONCURRENCY: "4" }).concurrency, 4);
});

test("evaluate_many keeps evaluating good states when one state is too large", async () => {
  const { client, fake, close } = await connect(KEY);
  const r = await client.callTool({
    name: "tenbin_evaluate_many",
    arguments: { states: [{ id: "ok", state: "urgent" }, { id: "huge", state: "x".repeat(128_000) }], questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } } },
  });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  const sc = r.structuredContent as any;
  assert.equal(fake.calls.length, 1, "the good state was sent");
  assert.equal(sc.summary.failures.length, 1);
  assert.equal(sc.summary.failures[0].id, "huge");
  assert.match(sc.summary.failures[0].error, /exceeds/);
  assert.equal(sc.rows.find((x: any) => x.id === "ok").answers.q.noul, 0.9);
  await close();
});

test("rank accepts a long query plus existence_check that fit the limit once shared questions are counted once", async () => {
  const { client, close } = await connect(KEY);
  const r = await client.callTool({
    name: "tenbin_rank",
    arguments: { query: "q".repeat(100_000), existence_check: "e".repeat(8_000), candidates: [{ id: "a", content: "relevant a" }, { id: "b", content: "b" }], instructions: "Is {candidate} relevant to `query`?" },
  });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  const sc = r.structuredContent as any;
  assert.equal(sc.batches, 1);
  assert.equal(sc.ranked[0].id, "a");
  await close();
});

test("evaluate_many stops scheduling after an authentication failure but keeps per-state failures partial", async () => {
  const bad = await connect({ TYPESAFE_API_KEY: "wrong-key", TENBIN_CONCURRENCY: "1" });
  const states = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, state: "urgent" }));
  const r = await bad.client.callTool({ name: "tenbin_evaluate_many", arguments: { states, questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } } } });
  const sc = r.structuredContent as any;
  assert.equal(bad.fake.calls.length, 1, "no request after the 401");
  assert.equal(sc.summary.failures.length, 1);
  assert.equal(sc.summary.skipped, 29);
  assert.equal(sc.summary.cancelled, 0);
  assert.match(sc.summary.stopped_reason, /TYPESAFE_API_KEY/);
  await bad.close();

  const good = await connect({ ...KEY, TENBIN_CONCURRENCY: "1" });
  const mixed = [{ id: "bad", state: "FAIL422" }, { id: "ok1", state: "urgent" }, { id: "ok2", state: "urgent" }];
  const r2 = await good.client.callTool({ name: "tenbin_evaluate_many", arguments: { states: mixed, questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } } } });
  const sc2 = r2.structuredContent as any;
  assert.equal(good.fake.calls.length, 3, "a 422 on one state does not stop the others");
  assert.equal(sc2.summary.failures.length, 1);
  assert.equal(sc2.summary.skipped, 0);
  await good.close();
});

test("rank choice mode with a long query and a long existence_check is not split into impossible singletons", async () => {
  const { client, close } = await connect(KEY);
  const candidates = [{ id: "a".repeat(1000), content: "relevant" }, { id: "b".repeat(1000), content: "other" }];
  const r = await client.callTool({
    name: "tenbin_rank",
    arguments: { query: "q".repeat(96_000), existence_check: "e".repeat(18_000), candidates, mode: "choice", instructions: "Which of {candidate} matches `query`?" },
  });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  assert.equal((r.structuredContent as any).batches, 1);
  await close();
});

test("a budget rejection on one row does not stop smaller rows or in-flight work", async () => {
  const { client, fake, close } = await connect({ ...KEY, TENBIN_CONCURRENCY: "1", TENBIN_SESSION_TOKEN_BUDGET: "30" });
  const r = await client.callTool({
    name: "tenbin_evaluate_many",
    arguments: { states: [{ id: "big", state: "x".repeat(80) }, { id: "small", state: "u" }], questions: { q: { type: "noul", instructions: "Does the message convey urgency?" } } },
  });
  const sc = r.structuredContent as any;
  assert.equal(fake.calls.length, 1, "the small row still ran");
  assert.equal(sc.summary.failures.length, 1);
  assert.equal(sc.summary.failures[0].id, "big");
  assert.equal(sc.summary.skipped, 0);
  assert.equal(sc.summary.stopped_reason, undefined);
  await close();
});

test("walk_taxonomy with many long-labelled categories stays under the request limits", async () => {
  const { client, close } = await connect(KEY);
  const taxonomy: Record<string, Record<string, null>> = {};
  for (let c = 0; c < 20; c++) {
    const leaves: Record<string, null> = {};
    for (let i = 0; i < 100; i++) leaves[`category${c}-${"leaf-".repeat(20)}${i}`] = null;
    taxonomy[`category${c}`] = leaves;
  }
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "something about category3", taxonomy, beam_width: 2, subtree_token_limit: 400 } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  assert.equal((r.structuredContent as any).paths[0].path[0], "category3");
  await close();
});

test("rank choice mode compares two large candidates in one request when the real limits allow it", async () => {
  const { client, close } = await connect(KEY);
  const candidates = [{ id: "a", content: "relevant " + "w".repeat(60_000) }, { id: "b", content: "w".repeat(60_000) }];
  const r = await client.callTool({ name: "tenbin_rank", arguments: { query: "q", candidates, mode: "choice", instructions: "Which of {candidate} matches `query`?" } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  const sc = r.structuredContent as any;
  assert.equal(sc.calls, 1);
  assert.equal(sc.ranked[0].id, "a");
  await close();
});

test("walk_taxonomy splits a level with more than 255 options and merges through a final round", async () => {
  const { client, fake, close } = await connect(KEY);
  const taxonomy: Record<string, null> = {};
  for (let i = 0; i < 300; i++) taxonomy[`cat${i}`] = null;
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "something about cat42", taxonomy, beam_width: 2 } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  const sc = r.structuredContent as any;
  assert.deepEqual(sc.paths[0].path, ["cat42"]);
  for (const c of fake.calls) for (const q of Object.values<any>(c.body.questions)) assert.ok(Object.keys(q.criteria).length <= 255);
  assert.equal(sc.decisions, 2, "one request holding both chunks, then the final round");
  await close();
});

test("walk_taxonomy spreads oversized levels across requests that stay under the API limits", async () => {
  const { client, fake, close } = await connect(KEY);
  const taxonomy: Record<string, Record<string, null>> = {};
  for (let c = 0; c < 200; c++) {
    const leaves: Record<string, null> = {};
    for (let i = 0; i < 40; i++) leaves[`cat${c}-${"leaf-".repeat(8)}${i}`] = null;
    taxonomy[`cat${c}`] = leaves;
  }
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "something about cat7", taxonomy, beam_width: 1, subtree_token_limit: 400 } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  assert.equal((r.structuredContent as any).paths[0].path[0], "cat7");
  for (const c of fake.calls) assert.ok(JSON.stringify(c.body).length / 4 <= 64_000, "every request under the API limit");
  await close();
});

test("walk_taxonomy chunking leaves room for the instructions and current path", async () => {
  const { client, fake, close } = await connect({ ...KEY, TENBIN_MAX_TOKENS_PER_CALL: "1000" });
  const taxonomy: Record<string, string> = {};
  for (let i = 0; i < 12; i++) taxonomy[`cat${i}`] = "label ".repeat(78);
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "about cat5", taxonomy, instructions: "Which option? " + "detail ".repeat(110), beam_width: 1 } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  assert.ok(fake.calls.length >= 2, "the level was split");
  for (const c of fake.calls) assert.ok(JSON.stringify(c.body).length / 4 <= 1000, "each request within the configured per-call limit");
  assert.equal((r.structuredContent as any).paths[0].path[0], "cat5");
  await close();
});

test("walk_taxonomy sends a level the margin chunker cannot split as one Choice when the real limits allow it", async () => {
  const { client, fake, close } = await connect(KEY);
  const big = (tag: string) => ({ [`${tag}-${"leaf-".repeat(300)}`]: null });
  const taxonomy = { alpha: big("a"), beta: big("b") };
  const r = await client.callTool({ name: "tenbin_walk_taxonomy", arguments: { state: "x".repeat(112_000) + " about beta", taxonomy, beam_width: 1, max_depth: 1 } });
  assert.equal(r.isError, undefined, String((r.content as any)[0].text));
  assert.equal(fake.calls.length, 1);
  assert.equal(Object.keys(fake.calls[0].body.questions.p0_r0_c0.criteria).length, 2, "both options compared in one Choice");
  assert.equal((r.structuredContent as any).paths[0].path[0], "beta");
  await close();
});
