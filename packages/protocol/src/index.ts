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
  fixed: z.boolean().optional(),           // command: true = a fixed command line; ask for it by name, no arguments (CONTRACT §2)
});
export type Offer = z.infer<typeof Offer>;

export const Role = z.enum(["daemon", "feed"]);
export type Role = z.infer<typeof Role>;

export const EventKind = z.enum(["prompt", "tool_call", "file_touched", "status", "note", "message", "file"]);
export type EventKind = z.infer<typeof EventKind>;

/** A file produced on a teammate's machine, held by the relay for ~1 h (docs/FILES-API.md). */
export const Artifact = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string().url(),
  sha256: z.string().optional(),
});
export type Artifact = z.infer<typeof Artifact>;

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
  artifacts: z.array(Artifact).optional(),
  artifactErrors: z.array(z.string()).optional(),
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
  gitOffers: z.boolean().default(true),            // add read-only git.status/diff/log/branch offers when cwd is a git repo
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
export const SendMessageInput = z.object({
  to: z.string().min(1).describe("teammate handle, or 'all'"),
  text: z.string().min(1).max(2000),
});
export const SendFileInput = z.object({ to: z.string().min(1), path: z.string().min(1), note: z.string().max(500).optional() });
export const FetchArtifactInput = z.object({ url: z.string().url().optional(), id: z.string().optional(), saveAs: z.string().optional() });
export const InboxInput = z.object({ unreadOnly: z.boolean().default(true), sinceMinutes: z.number().int().positive().default(120) });
export const InboxMessage = z.object({ id: z.string(), ts: z.string(), from: z.string(), to: z.string(), text: z.string(), read: z.boolean(), artifact: Artifact.optional() });
export type InboxMessage = z.infer<typeof InboxMessage>;
export const TeamActivityInput = z.object({ sinceMinutes: z.number().int().positive().default(10) });
/** approve_request tool / POST /decide: the owner's answer to a request parked in the daemon's pending queue. */
export const ApproveRequestInput = z.object({
  id: z.string().min(1),
  decision: z.enum(["approved", "denied"]),
  reason: z.string().max(300).optional(),
});
export type ApproveRequestInput = z.infer<typeof ApproveRequestInput>;
/** One entry of GET /pending: an incoming request waiting for the owner's decision. */
export const PendingRequest = z.object({
  id: z.string(),
  from: z.string(),
  why: z.string(),
  command: z.string().optional(),
  tool: z.string().optional(),
  args: z.record(z.unknown()).optional(),
  createdAt: z.string(), // ISO
  expiresAt: z.string(), // ISO: after this the daemon falls back to its native dialog / tty prompt
});
export type PendingRequest = z.infer<typeof PendingRequest>;

export const JobStatus = z.enum(["pending", "running", "completed", "denied"]);
export type JobStatus = z.infer<typeof JobStatus>;
export const JobResult = z.object({
  jobId: z.string(),
  status: JobStatus,
  exitCode: z.number().nullable().optional(),
  output: z.string().optional(),
  durationMs: z.number().optional(),
  reason: z.string().optional(),
  artifacts: z.array(Artifact).optional(),
  artifactErrors: z.array(z.string()).optional(),
});
export type JobResult = z.infer<typeof JobResult>;

/** Tool descriptions — copy verbatim into the MCP server. These teach the model when to use us. */
export const TOOL_DESCRIPTIONS = {
  list_teammates:
    "List teammates currently online and every tool or command each one can run for you on their machine (their MCP servers: Supabase, Figma, Linear, GitHub, etc., plus shell commands). Call this whenever you need a tool, credential, dataset, or environment you don't have, before telling the user you can't do something. Then call describe_capability on the specific tool before using it.",
  describe_capability:
    "Full description, input schema, owner notes, and an example call for one teammate capability. Always call this before ask_teammate on a tool you haven't used in this session; the owner's notes contain project-specific details (IDs, table names, conventions) you cannot guess.",
  ask_teammate:
    "Use a teammate's tool (tool + args, from describe_capability) or run a shell command on their machine (command). They see exactly what you're asking and your `why`, and must approve unless the capability is marked 'always'. Shell commands run in the owner's configured working directory with their environment. A shell offer marked fixed: true is one exact command line the owner chose (e.g. git.diff runs `git diff HEAD`): pass command: '<offer name>' and nothing else; arguments or extra flags will not match it. Returns { status, exitCode, output }: exitCode 0 = success, 1 = the tool reported an error, null = killed at the owner's timeout. If status is 'running', call check_job with the jobId. If 'denied', do not retry the same request; tell the user why.",
  check_job: "Check on, or wait for, a job started by ask_teammate. waitSeconds blocks up to that long for completion (0 = return immediately). Same result shape as ask_teammate; exitCode null means it was killed at the owner's timeout.",
  post_event: "Post a short note to the team activity feed (what you're doing, what you found).",
  send_message:
    "Send a short message to a teammate's agent ('all' for everyone). Use it to coordinate: what you're about to change, a fix idea for something you saw in team_activity, a question about their tool. Delivered live to their terminal and the room page, and into their agent's context on its next prompt (Claude Code) or when it calls inbox (Cursor).",
  inbox:
    "Unread messages from teammates addressed to you or to everyone. Call it when you start a task or when team_activity shows a message. Marks them read.",
  send_file:
    "Send a file from this machine to a teammate's agent ('all' = everyone). Path must be inside the project or ~/.mesh. The recipient's agent downloads it with fetch_artifact.",
  fetch_artifact:
    "Download an artifact a teammate produced (from ask_teammate results, inbox, or team_activity) into ./mesh-artifacts/. Images are also returned inline so you can look at them.",
  team_activity:
    "What teammates and their agents have done recently: prompts, tool calls, files touched, requests. Check before editing files others may be working on.",
  approve_request:
    "Approve or deny a teammate's pending request to use this machine. Only call this after the user has explicitly said yes or no to the specific request shown in the mesh notification. Claude Code's own permission prompt for this call is where they say it: when a mesh notification reports a pending request, call this with decision 'approved' right away and let that prompt ask the user; if the user rejects the prompt, call again with decision 'denied' (and their reason, if any) so the teammate is told. Never decide on the user's behalf.",
} as const;

export const DEFAULT_PORT = 7337;
export const HISTORY_LIMIT = 200;
export const OUTPUT_TAIL_BYTES = 8192;
