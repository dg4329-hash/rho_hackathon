/**
 * Internal seams between the two halves of the daemon.
 *   core.ts        (transport, jobs, approvals, shell exec, cli)  implements DaemonCore, consumes McpImport + LocalServer
 *   mcp-import.ts  (owner's MCP servers as an MCP client)          implements McpImport
 *   local-server.ts(HTTP + MCP server for the IDE agent)           implements LocalServer
 * Do not change these interfaces without telling the other builder.
 */
import type { Offer, Role, TeamConfig, JobResult, EventKind, InboxMessage, PendingRequest, Artifact } from "@mesh/protocol";

export interface Member { user: string; role: Role; offers: Offer[] }

export interface Job {
  id: string;
  from: string;
  to: string;
  why: string;
  command?: string;
  tool?: string;
  args?: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "denied";
  chunks: string[];          // output so far (stdout+stderr interleaved), each ≤ 4 KB
  exitCode?: number | null;
  durationMs?: number;
  reason?: string;           // when denied
  createdAt: number;         // Date.now()
  artifacts?: Artifact[];    // from the result frame (docs/FILES-API.md)
  artifactErrors?: string[];
}

/** What fetch_artifact writes to disk. `from` is the uploader (the mesh-artifacts/<from>/ folder). */
export interface FetchedArtifact { path: string; name: string; mime: string; size: number; from: string }

/** A non-text MCP content part passed through callTool so core can upload images / blobs as artifacts. */
export interface McpContentPart { type: string; mimeType?: string; data?: string; uri?: string; blob?: string }

export interface ActivityEntry { ts: string; from: string; type: string; summary: string }

export interface AskInput {
  who: string;
  why: string;
  command?: string;
  tool?: string;
  args?: Record<string, unknown>;
  waitSeconds: number;
}

/** Implemented by core.ts. Consumed by local-server.ts. */
export interface DaemonCore {
  readonly me: string;
  readonly config: TeamConfig;
  /** Working directory shell offers run in and artifacts are saved under (mesh-artifacts/). */
  readonly cwd: string;
  /** Members from the last presence frame, excluding self. Feeds included with role 'feed'. */
  members(): Member[];
  findOffer(who: string, name: string): Offer | undefined;
  /** Emit a request, wait up to waitSeconds for decision/result. Never throws for denied/timeout; returns JobResult. */
  ask(input: AskInput): Promise<JobResult>;
  checkJob(jobId: string, waitSeconds: number): Promise<JobResult>;
  postEvent(kind: EventKind, summary: string, data?: Record<string, unknown>): void;
  /** Human-readable flattening of the last N minutes of frames seen (events, requests, decisions, results). Newest last, ≤ 100. */
  activity(sinceMinutes: number): ActivityEntry[];
  /** Send a message event to a teammate ('all' = everyone). */
  sendMessage(to: string, text: string): void;
  /** Messages addressed to me or 'all'. unreadOnly marks returned messages read. */
  inbox(opts: { unreadOnly: boolean; sinceMinutes: number }): InboxMessage[];
  relayStatus(): "connected" | "disconnected";
  /** Leave the room: disconnect, forget the saved join so nothing auto-restarts, and exit the daemon (after `delayMs`). */
  leave(reason?: string, delayMs?: number): void;
  /**
   * Incoming requests waiting for the owner's decision (the in-tool approval path). Long-polls up to
   * waitMs when empty. Calling it marks a watcher as attached, which routes new approvals here.
   */
  pendingApprovals(waitMs: number): Promise<PendingRequest[]>;
  /** For `mesh watch`: pending approvals plus unread messages (marked read once handed to the watcher). */
  /** opts.since (ISO): return messages newer than it WITHOUT marking read (overlay); otherwise unread messages are returned and marked read (agent watcher). */
  watchPoll(waitMs: number, opts?: { since?: string }): Promise<{ pending: PendingRequest[]; messages: InboxMessage[] }>;
  /** Answer a pending request. False when the id is not (or no longer) pending. */
  decide(id: string, decision: "approved" | "denied", reason?: string): boolean;
  /**
   * Upload a file (must be under cwd or ~/.mesh) to the relay and emit an `event` kind `file` to a teammate
   * ('all' = everyone). Throws with a readable message when the path is outside those roots or the upload fails.
   */
  sendFile(to: string, filePath: string, note?: string): Promise<Artifact>;
  /**
   * Download an artifact (by url, or by id looked up in recent results / inbox) to
   * <cwd>/mesh-artifacts/<from>/<name>. saveAs overrides the file name; never writes outside cwd.
   */
  fetchArtifact(input: { url?: string; id?: string; saveAs?: string }): Promise<FetchedArtifact>;
}

/** Implemented by mcp-import.ts. Consumed by core.ts when serving incoming `tool` requests and when building `hello` offers. */
export interface McpImport {
  /** Discover + connect configured servers. Never throws; returns what it could import. */
  start(config: TeamConfig, cwd: string): Promise<{ offers: Offer[]; skipped: Array<{ server: string; reason: string }> }>;
  /** null if args satisfy the offer's inputSchema, else a human-readable error. Unknown offer → error string. */
  validateArgs(offerName: string, args: Record<string, unknown>): string | null;
  /**
   * Call the tool on the owner's server. Flatten content to text. Throws on transport failure.
   * `parts` carries the non-text content parts (image / audio / resource) verbatim so core can turn them into artifacts.
   */
  callTool(offerName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; parts?: McpContentPart[] }>;
  stop(): Promise<void>;
}

/** Implemented by local-server.ts. Consumed by cli.ts. */
export interface LocalServer {
  start(core: DaemonCore, port: number): Promise<void>;
  stop(): Promise<void>;
}
