import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

const RESOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources");

const GUIDES: Record<string, string> = {
  suggestions: "Suggest uses for Tenbin grounded in the current project: evidence, atomic judgments, integration points, and minimal validation",
  primitives: "Choice / Score / Noul: request shape, choosing a type, asking many questions at once, limits",
  confidence: "What confidence means, the three ranges, risk-scaled thresholds, what not to do",
  patterns: "Fan-out, confidence-gated routing, composite scoring, intent routing, two-stage, verification, guardrail",
  jaggedness: "Known failure modes of jev-1.13 and the code-side alternative for each",
  cookbooks: "Index of the 18 official cookbooks: problem -> slug -> key numbers",
};

export function registerResources(server: McpServer): void {
  for (const [name, description] of Object.entries(GUIDES)) {
    server.registerResource(`guide-${name}`, `tenbin://guide/${name}`, { title: `TypeSafe guide: ${name}`, description, mimeType: "text/markdown" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readFile(path.join(RESOURCE_DIR, `${name}.md`), "utf8") }],
    }));
  }

  server.registerResource(
    "example",
    new ResourceTemplate("tenbin://examples/{name}", {
      list: async () => ({
        resources: (await readdir(path.join(RESOURCE_DIR, "examples"))).filter((f) => f.endsWith(".json")).map((f) => ({
          uri: `tenbin://examples/${f.replace(/\.json$/, "")}`,
          name: f.replace(/\.json$/, ""),
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Complete request examples", description: "Ready-to-send {state, questions} bodies: triage, guardrail, extraction", mimeType: "application/json" },
    async (uri, { name }) => {
      const safe = String(name).replace(/[^a-z0-9_-]/gi, "");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: await readFile(path.join(RESOURCE_DIR, "examples", `${safe}.json`), "utf8") }] };
    },
  );
}
