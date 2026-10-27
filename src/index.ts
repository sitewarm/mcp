#!/usr/bin/env node
import { VERSION } from "./version.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, configFromEnv, visibleTools } from "./call.js";
import { buildTools, loadAllowlist, loadSpec } from "./spec.js";

const cfg = (() => {
  try {
    return configFromEnv(process.env);
  } catch (e) {
    process.stderr.write(`sitewarm-mcp: ${(e as Error).message}\n`);
    process.exit(2);
  }
})();

const tools = visibleTools(
  buildTools(loadSpec(new URL("../openapi/openapi.yaml", import.meta.url)), loadAllowlist(new URL("../tools/allowlist.json", import.meta.url))),
  cfg,
);

const server = new Server({ name: "sitewarm", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as { type: "object" },
    annotations: t.annotations,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `Unknown tool ${req.params.name}.` }] };
  const r = await callTool(tool, req.params.arguments, cfg);
  return { isError: r.isError, content: [{ type: "text", text: r.text }] };
});

await server.connect(new StdioServerTransport());
