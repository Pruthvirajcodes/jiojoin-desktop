/**
 * Client side of the engine's newline-delimited JSON protocol. It knows
 * nothing about processes: give it a way to write a line and feed it the
 * bytes that come back. See engine/src/engine.c for the other end.
 */

export const ENGINE_PROTOCOL = 1;

export interface EngineHello {
  engine: string;
  protocol: number;
  pjsip: string;
  tls: boolean;
  codecs: string[];
}

export type EngineRegState = "registering" | "registered" | "unregistered" | "failed";
export type EngineCallState = "calling" | "ringing" | "incoming" | "connecting" | "active" | "ended";

export type EngineEvent =
  | { event: "ready"; protocol: number; engine: string }
  | { event: "fatal"; error: string }
  | { event: "reg"; state: EngineRegState; code: number; reason: string; expires: number }
  | { event: "transport"; state: "connected" | "disconnected" | "rejected"; reason?: string }
  | {
      event: "call";
      callId: number;
      direction: "in" | "out";
      state: EngineCallState;
      number: string;
      name: string;
      code: number;
      reason: string;
      held: boolean;
      remoteHeld: boolean;
      muted: boolean;
      codec?: string;
      /** On "ended": the gateway cancelled the ringing because another device answered. */
      elsewhere?: boolean;
    }
  | { event: "busyReject"; number: string; name: string }
  | { event: "level"; mic: number; speaker: number };

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/** Splits a byte stream into lines, holding back a trailing partial line. */
export class LineSplitter {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line !== "");
  }
}

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class EngineProtocol {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly splitter = new LineSplitter();
  private closed = false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly onEvent: (event: EngineEvent) => void,
  ) {}

  /** Feed raw stdout data from the engine. */
  receive(chunk: string): void {
    for (const line of this.splitter.push(chunk)) this.handleLine(line);
  }

  request<T = Record<string, unknown>>(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new EngineError("the calling engine is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError(`engine did not answer "${cmd}"`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
    });
  }

  /** Call when the engine process is gone; fails everything still waiting. */
  close(reason = "the calling engine stopped"): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new EngineError(reason));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;

    if (typeof record.event === "string") {
      this.onEvent(record as unknown as EngineEvent);
      return;
    }
    if (typeof record.id !== "number") return;
    const waiting = this.pending.get(record.id);
    if (!waiting) return;
    this.pending.delete(record.id);
    clearTimeout(waiting.timer);
    if (record.ok === true) waiting.resolve(record);
    else waiting.reject(new EngineError(typeof record.error === "string" ? record.error : "engine error"));
  }
}
