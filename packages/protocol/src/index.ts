/**
 * @mesh/protocol — the TypeScript form of docs/CONTRACT.md.
 * If this file and CONTRACT.md disagree, this file wins; fix the doc.
 */
import { z } from "zod";

// ---------- shared ----------
export const Permission = z.enum(["always", "ask", "never"]);
export type Permission = z.infer<typeof Permission>;

export const Offer = z.object({
  name: z.string().min(1),
  description: z.string(),
  permission: Permission,
});
export type Offer = z.infer<typeof Offer>;

export const Role = z.enum(["daemon", "feed"]);
export type Role = z.infer<typeof Role>;

export const EventKind = z.enum(["prompt", "tool_call", "file_touched", "status", "note"]);
export type EventKind = z.infer<typeof EventKind>;

const base = { from: z.string().min(1), ts: z.string() };

// ---------- relay frames (CONTRACT §1) ----------
export const HelloFrame = z.object({ type: z.literal("hello"), ...base, role: Role, offers: z.array(Offer) });
export const RequestFrame = z.object({
  type: z.literal("request"), ...base,
  id: z.string(), to: z.string(), command: z.string().min(1), why: z.string(), offer: z.string().optional(),
});
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

export const Frame = z.discriminatedUnion("type", [
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
export const TeamConfig = z.object({
  user: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  room: z.string().min(1),
  relay: z.string().url(),
  cwd: z.string().optional(),
  timeoutSeconds: z.number().int().positive().default(120),
  allowArbitrary: z.enum(["ask", "never"]).default("ask"),
  offers: z.array(Offer.extend({ command: z.string().min(1) })).default([]),
});
export type TeamConfig = z.infer<typeof TeamConfig>;

// ---------- MCP tool inputs / outputs (CONTRACT §3) ----------
export const AskTeammateInput = z.object({
  who: z.string(), command: z.string().min(1), why: z.string(),
  waitSeconds: z.number().int().min(1).max(120).default(45),
});
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
    "List teammates currently online and the commands each one offers to run on their machine. Call this when you need a tool, credential, or environment you don't have (e.g. Figma, Vercel, a deploy key). Offers include usage notes; follow them exactly.",
  ask_teammate:
    "Run a shell command on a teammate's machine. They will see the command and your `why`, and must approve it (unless the offer is marked 'always'). Use the exact command syntax from their offer description. Returns stdout/stderr. If status is 'running', call check_job with the jobId. If 'denied', do not retry the same command; tell the user.",
  check_job: "Check on, or wait for, a job started by ask_teammate.",
  post_event: "Post a short note to the team activity feed (what you're doing, what you found).",
  team_activity:
    "What teammates and their agents have done recently: prompts, tool calls, files touched, requests. Check before editing files others may be working on.",
} as const;

export const DEFAULT_PORT = 7337;
export const HISTORY_LIMIT = 200;
export const OUTPUT_TAIL_BYTES = 8192;
