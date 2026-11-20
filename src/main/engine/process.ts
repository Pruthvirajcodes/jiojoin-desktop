import { type ChildProcess, spawn } from "node:child_process";
import { log } from "../logger";
import { ENGINE_PROTOCOL, type EngineEvent, type EngineHello, EngineError, EngineProtocol, LineSplitter } from "./protocol";

/** What the rest of the app needs from a calling engine, real or simulated. */
export interface Engine {
  /** Starts a fresh engine (stopping any previous one) and returns its capabilities. */
  start(): Promise<EngineHello>;
  stop(): Promise<void>;
  request<T = Record<string, unknown>>(
    cmd: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  readonly running: boolean;
  onEvent: (event: EngineEvent) => void;
  /** Called when the engine exits without having been asked to. */
  onCrash: () => void;
}

const READY_TIMEOUT_MS = 15_000;

/**
 * Runs the native engine as a child process. Native crashes stay out of the
 * app, and killing the child is a complete reset of all SIP and audio state.
 */
export class EngineProcess implements Engine {
  private child: ChildProcess | null = null;
  private protocol: EngineProtocol | null = null;
  private stopping = false;
  onEvent: (event: EngineEvent) => void = () => {};
  onCrash: () => void = () => {};

  constructor(private readonly binaryPath: string) {}

  get running(): boolean {
    return this.child !== null;
  }

  async start(): Promise<EngineHello> {
    await this.stop();
    this.stopping = false;

    // Credentials go over stdin only: argv and the environment are visible
    // to other processes.
    const child = spawn(this.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;

    let onReady: () => void = () => {};
    let onFailed: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      onFailed = reject;
    });
    const readyTimer = setTimeout(
      () => onFailed(new EngineError("the calling engine did not start")),
      READY_TIMEOUT_MS,
    );

    const protocol = new EngineProtocol(
      (line) => {
        if (child.stdin?.writable) child.stdin.write(line);
      },
      (event) => {
        if (event.event === "ready") onReady();
        else if (event.event === "fatal") onFailed(new EngineError(event.error));
        else this.onEvent(event);
      },
    );
    this.protocol = protocol;

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => protocol.receive(chunk));
    const stderr = new LineSplitter();
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of stderr.push(chunk)) {
        const level = Number(line[0]);
        const text = line.replace(/^\d\s+/, "").trim();
        if (level <= 2) log.warn("engine", text);
        else log.info("engine", text);
      }
    });
    child.stdin?.on("error", () => {});
    child.once("error", (error) => {
      onFailed(new EngineError(`the calling engine could not start (${error.message})`));
    });
    child.once("exit", (code, signal) => {
      protocol.close();
      onFailed(new EngineError("the calling engine stopped while starting"));
      if (this.child !== child) return;
      this.child = null;
      this.protocol = null;
      if (!this.stopping) {
        log.error("engine", `exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"})`);
        this.onCrash();
      }
    });

    try {
      await ready;
      const hello = await protocol.request<EngineHello>("hello");
      if (hello.protocol !== ENGINE_PROTOCOL) {
        throw new EngineError("the calling engine is a different version from the app");
      }
      log.info("engine", `ready: ${hello.engine}, PJSIP ${hello.pjsip}, codecs ${hello.codecs.join(" ")}`);
      return hello;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(readyTimer);
    }
  }

  request<T = Record<string, unknown>>(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.protocol) return Promise.reject(new EngineError("the calling engine is not running"));
    return this.protocol.request<T>(cmd, params, timeoutMs);
  }

  async stop(): Promise<void> {
    const child = this.child;
    const protocol = this.protocol;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    this.protocol = null;

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    // "quit" lets the engine remove its registration before it goes.
    protocol?.request("quit", {}, 1500).catch(() => {});
    const timer = setTimeout(() => child.kill(), 4000);
    await exited;
    clearTimeout(timer);
    protocol?.close();
  }
}
