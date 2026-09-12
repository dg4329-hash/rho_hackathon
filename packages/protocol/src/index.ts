/**
 * @mesh/protocol — the TypeScript form of docs/CONTRACT.md.
 * If this file and CONTRACT.md disagree, this file wins; fix the doc.
 */
import { z } from "zod";

// ---------- shared ----------
export const Permission = z.enum(["always", "ask", "never"]);
export type Permission = z.infer<typeof Permission>;

export const OfferKind = z.enum(["command", "mcp"]);
export type OfferKind = z.infer<typeof OfferKind>;

/** One thing a teammate can do for you. mcp offers are imported verbatim from their MCP servers. */
export const Offer = z.object({
  kind: OfferKind,
  name: z.string().min(1),                 // command: 'figma.export'; mcp: '<server>.<tool>'
  description: z.string(),                 // mcp: server's own description, verbatim
  permission: Permission,
  inputSchema: z.record(z.unknown()).optional(), // mcp: JSON Schema, verbatim
  notes: z.string().optional(),            // owner-written guidance
  server: z.string().optional(),           // mcp: source server name
});
export type Offer = z.infer<typeof Offer>;

export const Role = z.enum(["daemon", "feed"]);
export type Role = z.infer<typeof Role>;

export const EventKind = z.enum(["prompt", "tool_call", "file_touched", "status", "note"]);
export type EventKind = z.infer<typeof EventKind>;

const base = { from: z.string().min(1), ts: z.string() };

// ---------- relay frames (CONTRACT §1) ----------
export const HelloFrame = z.object({ type: z.literal("hello"), ...base, role: Role, offers: z.array(Offer) });
export const RequestFrame = z
  .object({
    type: z.literal("request"), ...base,
    id: z.string(), to: z.string(), why: z.string(),
    command: z.string().min(1).optional(),            // shell form
    tool: z.string().min(1).optional(),               // mcp form: '<server>.<tool>'
    args: z.record(z.unknown()).optional(),
  })
  .refine((r) => (r.command ? 1 : 0) + (r.tool ? 1 : 0) === 1, { message: "exactly one of command or tool" });
export const DecisionFrame = z.object({
  type: z.literal("decision"), ...base,
  id: z.string(), decision: z.enum(["approved", "denied", "auto"]), reason: z.string().optional(),
});
export const OutputFrame = z.object({
  type: z.literal("output"), ...base,
  id: z.string(), stream: z.enum(["stdout", "stderr"]), chunk: z.string().max(4096),
});
export const ResultFrame = z.object({
  type: z.literal("result"), ...base,
  id: z.string(), exitCode: z.number().nullable(), durationMs: z.number(), timedOut: z.boolean(), tail: z.string(),
});
export const EventFrame = z.object({
  type: z.literal("event"), ...base,
  kind: EventKind, summary: z.string(), data: z.record(z.unknown()).optional(),
});
// relay-emitted
export const PresenceFrame = z.object({
  type: z.literal("presence"),
  members: z.array(z.object({ user: z.string(), role: Role, offers: z.array(Offer) })),
});
export const ErrorFrame = z.object({ type: z.literal("error"), message: z.string() });

export const Frame = z.union([
  HelloFrame, RequestFrame, DecisionFrame, OutputFrame, ResultFrame, EventFrame, PresenceFrame, ErrorFrame,
]);
export type Frame = z.infer<typeof Frame>;
export type HelloFrame = z.infer<typeof HelloFrame>;
export type RequestFrame = z.infer<typeof RequestFrame>;
export type DecisionFrame = z.infer<typeof DecisionFrame>;
export type OutputFrame = z.infer<typeof OutputFrame>;
export type ResultFrame = z.infer<typeof ResultFrame>;
export type EventFrame = z.infer<typeof EventFrame>;
export type PresenceFrame = z.infer<typeof PresenceFrame>;

/** Parse one WebSocket frame. Throws ZodError on anything malformed. */
export function parseFrame(json: unknown): Frame {
  const obj = typeof json === "string" ? JSON.parse(json) : json;
  return Frame.parse(obj);
}

// ---------- team.json (CONTRACT §2) ----------
export const ShellOfferConfig = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  description: z.string(),
  permission: Permission,
  notes: z.string().optional(),
});
export const ImportConfig = z.object({
  fromClaudeCode: z.boolean().default(true),
  fromCursor: z.boolean().default(true),
  servers: z.array(z.string()).default(["*"]),
  defaultPermission: Permission.default("ask"),
});
export const TeamConfig = z.object({
  user: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  room: z.string().min(1),
  relay: z.string().url(),
  cwd: z.string().optional(),
  timeoutSeconds: z.number().int().positive().default(120),
  allowArbitrary: z.enum(["ask", "never"]).default("ask"),
  import: ImportConfig.default({}),
  permissions: z.record(Permission).default({}),   // glob on offer name → permission
  notes: z.record(z.string()).default({}),         // glob on offer name → owner notes
  offers: z.array(ShellOfferConfig).default([]),   // shell offers
});
export type ShellOfferConfig = z.infer<typeof ShellOfferConfig>;
export type TeamConfig = z.infer<typeof TeamConfig>;

// ---------- MCP tool inputs / outputs (CONTRACT §3) ----------
export const AskTeammateInput = z
  .object({
    who: z.string(), why: z.string(),
    command: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    args: z.record(z.unknown()).optional(),
    waitSeconds: z.number().int().min(1).max(120).default(45),
  })
  .refine((r) => (r.command ? 1 : 0) + (r.tool ? 1 : 0) === 1, { message: "exactly one of command or tool" });
export const DescribeCapabilityInput = z.object({ who: z.string(), name: z.string() });
export const OfferSummary = z.object({ name: z.string(), kind: OfferKind, permission: Permission, summary: z.string() });
export const DescribeCapabilityOutput = Offer.extend({ usage: z.string() });
export const CheckJobInput = z.object({ jobId: z.string(), waitSeconds: z.number().int().min(0).max(120).default(0) });
export const PostEventInput = z.object({ kind: EventKind, summary: z.string(), data: z.record(z.unknown()).optional() });
export const TeamActivityInput = z.object({ sinceMinutes: z.number().int().positive().default(10) });

export const JobStatus = z.enum(["pending", "running", "completed", "denied"]);
export type JobStatus = z.infer<typeof JobStatus>;
export const JobResult = z.object({
  jobId: z.string(),
  status: JobStatus,
  exitCode: z.number().nullable().optional(),
  output: z.string().optional(),
  durationMs: z.number().optional(),
  reason: z.string().optional(),
});
export type JobResult = z.infer<typeof JobResult>;

/** Tool descriptions — copy verbatim into the MCP server. These teach the model when to use us. */
export const TOOL_DESCRIPTIONS = {
  list_teammates:
    "List teammates currently online and every tool or command each one can run for you on their machine (their MCP servers: Supabase, Figma, Linear, GitHub, etc., plus shell commands). Call this whenever you need a tool, credential, dataset, or environment you don't have, before telling the user you can't do something. Then call describe_capability on the specific tool before using it.",
  describe_capability:
    "Full description, input schema, owner notes, and an example call for one teammate capability. Always call this before ask_teammate on a tool you haven't used in this session; the owner's notes contain project-specific details (IDs, table names, conventions) you cannot guess.",
  ask_teammate:
    "Use a teammate's tool (tool + args, from describe_capability) or run a shell command on their machine (command). They see exactly what you're asking and your `why`, and must approve unless the capability is marked 'always'. Returns the tool result or stdout/stderr. If status is 'running', call check_job with the jobId. If 'denied', do not retry the same request; tell the user why.",
  check_job: "Check on, or wait for, a job started by ask_teammate.",
  post_event: "Post a short note to the team activity feed (what you're doing, what you found).",
  team_activity:
    "What teammates and their agents have done recently: prompts, tool calls, files touched, requests. Check before editing files others may be working on.",
} as const;

export const DEFAULT_PORT = 7337;
export const HISTORY_LIMIT = 200;
export const OUTPUT_TAIL_BYTES = 8192;
