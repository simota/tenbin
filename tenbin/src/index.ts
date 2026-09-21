#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TypeSafeGateway } from "./client.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
let gateway: TypeSafeGateway | null = null;
try {
  gateway = new TypeSafeGateway(config);
} catch (err) {
  console.error(`[tenbin] ${err instanceof Error ? err.message : err}\n[tenbin] Starting in offline mode: tenbin_lint_questions, the tenbin, design_questions, design_integration and decompose_judgment prompts, and guide/example resources are available.`);
}

const server = createServer(config, gateway);
await server.connect(new StdioServerTransport());
console.error(`[tenbin] ready (${gateway ? `model ${config.defaultModel}` : "offline"})`);
