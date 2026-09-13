/** Tiny stdio MCP server used by test/mcp.test.ts + artifacts.test.ts: `add {a,b}`, `fail {}` (returns isError), `pixel {}` (image part). */
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
/** 1x1 red PNG, base64 — the smallest real image an MCP tool can hand back. */
export const PIXEL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
server.registerTool("pixel", { description: "Returns a 1x1 PNG as an image content part.", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "here is your pixel" }, { type: "image", data: PIXEL_PNG_B64, mimeType: "image/png" }],
}));
await server.connect(new StdioServerTransport());
