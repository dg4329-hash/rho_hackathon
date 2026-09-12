/** Tiny stdio MCP server used by test/mcp.test.ts: `add {a,b}` and `fail {}` (returns isError). */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fixture", version: "0.0.1" });
server.registerTool("add", {
  description: "Add two numbers.",
  inputSchema: { a: z.number().describe("first"), b: z.number().describe("second") },
}, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
server.registerTool("fail", { description: "Always fails.", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "boom" }], isError: true,
}));
await server.connect(new StdioServerTransport());
