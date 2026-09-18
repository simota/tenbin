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
  console.error(`[tenbin] ${err instanceof Error ? err.message : err}\n[tenbin] Starting in offline mode: only tenbin_lint_questions is available.`);
}

const server = createServer(config, gateway);
await server.connect(new StdioServerTransport());
console.error(`[tenbin] ready (${gateway ? `model ${config.defaultModel}` : "offline"})`);
