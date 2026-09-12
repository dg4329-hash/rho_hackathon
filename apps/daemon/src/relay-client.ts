/**
 * WebSocket client to the relay. Reconnects forever with backoff (1 s → 10 s), keeps the last
 * 200 frames seen, tracks the last presence, and emits typed events.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import chalk from "chalk";
import { HISTORY_LIMIT, parseFrame, type Frame, type Offer, type PresenceFrame, type Role } from "@mesh/protocol";

export const DEBUG = process.env.MESH_DEBUG === "1";
export function debug(...args: unknown[]): void {
  if (DEBUG) console.error(chalk.dim(`[mesh ${new Date().toISOString()}]`), ...args);
}

export interface RelayClientOptions {
  relay: string;
  room: string;
  user: string;
  role?: Role;
  offers?: Offer[];
}

export interface SeenFrame {
  frame: Frame;
  receivedAt: number;
}

/** Frames clients send. `from`/`ts` are stamped by send() when missing. */
export type Outgoing = Extract<Frame, { from: string }>;
export type OutgoingInput = {
  [K in Outgoing["type"]]: Omit<Extract<Outgoing, { type: K }>, "from" | "ts"> & { from?: string; ts?: string };
}[Outgoing["type"]];

export interface RelayClientEvents {
  open: [];
  close: [];
  frame: [Frame];
  presence: [PresenceFrame];
}

const OUTBOX_LIMIT = 500;

export class RelayClient extends EventEmitter<RelayClientEvents> {
  private outbox: string[] = [];
  readonly user: string;
  readonly room: string;
  readonly relay: string;
  readonly role: Role;
  offers: Offer[];
  private ws: WebSocket | undefined;
  private connected = false;
  private closed = false;
  private backoffMs = 1000;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private lastPresence: PresenceFrame | undefined;
  private readonly history: SeenFrame[] = [];

  constructor(opts: RelayClientOptions) {
    super();
    this.relay = opts.relay;
    this.room = opts.room;
    this.user = opts.user;
    this.role = opts.role ?? "daemon";
    this.offers = opts.offers ?? [];
  }

  get url(): string {
    const base = this.relay.replace(/\/+$/, "");
    const q = new URLSearchParams({ room: this.room, user: this.user, role: this.role });
    return `${base}/?${q.toString()}`;
  }

  /** Start connecting (and keep reconnecting). Resolves on the first successful open. */
  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve) => {
      this.once("open", () => resolve());
      this.dial();
    });
  }

  private dial(): void {
    if (this.closed) return;
    debug("dial", this.url);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.backoffMs = 1000;
      this.send({ type: "hello", role: this.role, offers: this.offers });
      this.flushOutbox();
      this.emit("open");
    });
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("error", (err) => debug("ws error", err.message));
    ws.on("close", (code, reason) => {
      const was = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = undefined;
      if (was) this.emit("close");
      if (this.closed) return;
      debug(`ws closed (${code} ${reason.toString()}); reconnect in ${this.backoffMs} ms`);
      this.reconnectTimer = setTimeout(() => this.dial(), this.backoffMs);
      this.backoffMs = Math.min(10_000, this.backoffMs * 2);
    });
  }

  private onMessage(raw: string): void {
    let frame: Frame;
    try {
      frame = parseFrame(raw);
    } catch (e) {
      debug("ignoring malformed frame:", raw.slice(0, 200), (e as Error).message);
      return;
    }
    debug("recv", raw.length > 600 ? `${raw.slice(0, 600)}…` : raw);
    this.history.push({ frame, receivedAt: Date.now() });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    if (frame.type === "presence") {
      this.lastPresence = frame;
      this.emit("presence", frame);
    } else if (frame.type === "error") {
      console.error(chalk.red(`relay error: ${frame.message}`));
    }
    this.emit("frame", frame);
  }

  /** Send a frame; `from`/`ts` stamped if absent. Returns false (frame dropped) when not connected. */
  send(input: OutgoingInput): boolean {
    const frame = { from: this.user, ts: new Date().toISOString(), ...input } as Outgoing;
    const raw = JSON.stringify(frame);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue (bounded) and flush after reconnect so a relay blip mid-job can't strand the requester.
      debug("queue (not connected)", frame.type);
      this.outbox.push(raw);
      if (this.outbox.length > OUTBOX_LIMIT) this.outbox.splice(0, this.outbox.length - OUTBOX_LIMIT);
      return false;
    }
    debug("send", raw.length > 600 ? `${raw.slice(0, 600)}…` : raw);
    this.ws.send(raw);
    this.record(frame as Frame);
    return true;
  }

  /** Our own sent frames go into history too, so activity() shows "me → tarush: <command>". */
  private record(frame: Frame): void {
    if (frame.type === "hello") return;
    this.history.push({ frame, receivedAt: Date.now() });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  private flushOutbox(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const queued = this.outbox.splice(0);
    for (const raw of queued) {
      debug("send (flushed)", raw.length > 600 ? `${raw.slice(0, 600)}…` : raw);
      this.ws.send(raw);
    }
  }

  presence(): PresenceFrame | undefined {
    return this.lastPresence;
  }

  /** Copy of the ring buffer, oldest first. */
  recent(): SeenFrame[] {
    return this.history.slice();
  }

  status(): "connected" | "disconnected" {
    return this.connected ? "connected" : "disconnected";
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = undefined;
    this.connected = false;
    ws?.close();
  }
}
