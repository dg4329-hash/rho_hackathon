/**
 * WebSocket client to the relay. Reconnects forever with backoff (1 s → 10 s), keeps the last
 * 200 frames seen, tracks the last presence, and emits typed events.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import chalk from "chalk";
import { HISTORY_LIMIT, ROOM_ENDED_CLOSE_CODE, parseFrame, type Frame, type Offer, type PresenceFrame, type Role } from "@mesh/protocol";

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
  /** Room key (docs/ROOM-KEYS.md); appended to the connect url as `&key=`. */
  key?: string;
}

/** What the user is told when the relay refuses the connection for want of a room key. */
export const ROOM_KEY_HELP = "this relay requires the room link (with its key). Get it from the room page.";
/** Relay close code for a missing/wrong room key (docs/ROOM-KEYS.md). */
export const ROOM_KEY_CLOSE_CODE = 4401;
/** The relay's `error` frame for a missing/wrong key: "room key required" | "wrong room key". */
export function isRoomKeyError(message: string): boolean {
  return /room key/i.test(message);
}

/** Thrown by connect()/switchRoom() when the relay rejected our key. `relayMessage` is the relay's own wording. */
export class RoomKeyError extends Error {
  readonly relayMessage: string;
  constructor(relayMessage: string) {
    super(ROOM_KEY_HELP);
    this.name = "RoomKeyError";
    this.relayMessage = relayMessage;
  }
}

/** The relay's `error` frame on connecting to a room whose owner ended it: "this session was ended by its owner". */
export function isRoomEndedError(message: string): boolean {
  return /session (was|has been) ended/i.test(message);
}

/** Thrown by connect()/switchRoom() when the room was ended by its owner. `relayMessage` is the relay's own wording. */
export class RoomEndedError extends Error {
  readonly relayMessage: string;
  constructor(relayMessage: string) {
    super(relayMessage);
    this.name = "RoomEndedError";
    this.relayMessage = relayMessage;
  }
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
  /** The relay refused our key (error frame mentioning the room key, or close 4401). No reconnect follows. */
  keyError: [string];
  /**
   * The room was ended by its owner (`room_ended` frame, close 4410, or the "ended" error frame on connect). No reconnect
   * follows. Outside a switchRoom() the client is shut down for good; during one, the switch fails and returns to the old room.
   */
  roomEnded: [string];
}

const OUTBOX_LIMIT = 500;
/** After the socket opens we wait this long for the relay's presence (or its room-key refusal) before calling it connected. */
const OPEN_GRACE_MS = 1200;

export class RelayClient extends EventEmitter<RelayClientEvents> {
  private outbox: string[] = [];
  /** True between (re)connect and the relay's post-replay presence frame. Requests seen while replaying are history, not new work. */
  replaying = false;
  readonly user: string;
  room: string;
  relay: string;
  key: string | undefined;
  /** True while switchRoom() is in flight: a key rejection then belongs to the caller, not to the process. */
  switching = false;
  readonly role: Role;
  offers: Offer[];
  private ws: WebSocket | undefined;
  private connected = false;
  private closed = false;
  /** shutdown() was called: this client never dials again (leave / stop), whatever connect() or switchRoom() try. */
  private ended = false;
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
    this.key = opts.key || undefined;
  }

  get url(): string {
    const base = this.relay.replace(/\/+$/, "");
    const q = new URLSearchParams({ room: this.room, user: this.user, role: this.role });
    if (this.key) q.set("key", this.key);
    return `${base}/?${q.toString()}`;
  }

  /**
   * Start connecting (and keep reconnecting). Resolves once the relay has accepted us — its first `presence`
   * frame, or OPEN_GRACE_MS after the socket opened if this relay sends none. Rejects with RoomKeyError when
   * the relay refuses our room key (it accepts the upgrade first and only then sends the error frame / 4401,
   * so "the socket opened" is not yet "we are in the room").
   */
  connect(): Promise<void> {
    if (this.ended) return Promise.reject(new Error("relay client was shut down (left the room)"));
    this.closed = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (grace) clearTimeout(grace);
        this.off("open", onOpen);
        this.off("presence", onPresence);
        this.off("keyError", onKey);
        this.off("roomEnded", onEnded);
        fn();
      };
      const onOpen = () => { if (!settled && !grace) grace = setTimeout(() => done(resolve), OPEN_GRACE_MS); };
      const onPresence = () => done(resolve);
      const onKey = (message: string) => done(() => reject(new RoomKeyError(message)));
      const onEnded = (message: string) => done(() => reject(new RoomEndedError(message)));
      this.on("open", onOpen);
      this.on("presence", onPresence);
      this.on("keyError", onKey);
      this.on("roomEnded", onEnded);
      this.dial();
    });
  }

  /** The relay said no to our key: stop for good (no reconnect loop) and tell whoever is listening. */
  private rejectKey(message: string): void {
    if (this.closed && !this.ws) return; // already handled (error frame then close 4401)
    debug("room key rejected", message);
    this.close();
    console.error(chalk.red(ROOM_KEY_HELP));
    this.emit("keyError", message);
  }

  /**
   * The owner ended the room: never reconnect. While switching, the switch fails (switchRoom's catch goes back to the
   * previous room); otherwise this client is shut down for good.
   */
  private endRoom(message: string): void {
    if (this.closed && !this.ws) return; // already handled (room_ended / error frame, then close 4410)
    debug("room ended", message);
    if (this.switching) this.close();
    else this.shutdown();
    this.emit("roomEnded", message);
  }

  private gen = 0;

  private dial(): void {
    if (this.closed || this.ended) return;
    debug("dial", this.url);
    const ws = new WebSocket(this.url);
    const gen = ++this.gen; // events from an older socket (e.g. after switchRoom) must not reconnect or mutate state
    this.ws = ws;
    ws.on("open", () => {
      if (gen !== this.gen) { try { ws.close(); } catch { /* ignore */ } return; }
      this.connected = true;
      this.backoffMs = 1000;
      this.replaying = true;
      this.send({ type: "hello", role: this.role, offers: this.offers });
      this.flushOutbox();
      this.emit("open");
    });
    ws.on("message", (data) => { if (gen === this.gen) this.onMessage(data.toString()); });
    ws.on("error", (err) => debug("ws error", err.message));
    ws.on("close", (code, reason) => {
      if (gen !== this.gen) return; // stale socket: the newer connection owns reconnect
      if (code === ROOM_KEY_CLOSE_CODE) {
        this.connected = false;
        if (this.ws === ws) this.ws = undefined;
        this.rejectKey(reason.toString() || "room key required");
        return;
      }
      if (code === ROOM_ENDED_CLOSE_CODE) {
        this.connected = false;
        if (this.ws === ws) this.ws = undefined;
        this.endRoom(reason.toString() || "this session was ended by its owner");
        return;
      }
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
      this.replaying = false; // relay sends presence right after the replay
      this.lastPresence = frame;
      this.emit("presence", frame);
    } else if (frame.type === "room_ended") {
      this.endRoom(frame.message);
      return;
    } else if (frame.type === "error") {
      if (isRoomEndedError(frame.message)) {
        this.endRoom(frame.message);
        return;
      }
      if (isRoomKeyError(frame.message)) {
        console.error(chalk.red(`relay error: ${frame.message}`));
        this.rejectKey(frame.message);
        return;
      }
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

  /**
   * Leave the current room and join another (optionally on another relay / with another key). History and
   * presence reset. `key: null` clears the key; `undefined` keeps the current one. If the new room refuses
   * our key, we go back to the previous room/key and rethrow the RoomKeyError.
   */
  async switchRoom(room: string, relay?: string, key?: string | null): Promise<void> {
    const prev = { room: this.room, relay: this.relay, key: this.key };
    this.switching = true;
    const reset = () => {
      this.history.length = 0;
      this.lastPresence = undefined;
      this.replaying = false;
      this.backoffMs = 1000;
    };
    try {
      this.close();
      this.room = room;
      if (relay) this.relay = relay;
      if (key !== undefined) this.key = key ?? undefined;
      reset();
      await this.connect();
    } catch (e) {
      this.close();
      this.room = prev.room;
      this.relay = prev.relay;
      this.key = prev.key;
      reset();
      this.connect().catch(() => undefined); // back to the room we were in
      throw e;
    } finally {
      this.switching = false;
    }
  }

  /** Close for good: no reconnect, and later connect() / switchRoom() calls are refused. */
  shutdown(): void {
    this.ended = true;
    this.close();
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
