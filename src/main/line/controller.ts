import type { LineState } from "@shared/types";
import { type Backend, fetchCredentials } from "../backend";
import type { EngineEvent } from "../engine/protocol";
import { log } from "../logger";
import { provisioningRefusal, registrationFailure, routerFailure } from "../reasons";
import { discoverRouter } from "../router/discovery";
import { RouterHttpError } from "../router/http";
import { type ProvisionedLine, buildSipAccount, numberFromIdentity } from "../router/provisioning";
import type { StateStore } from "../store/state";
import type { Vault } from "../store/vault";
import { type LineEffect, type LineEvent, SIGNED_OUT, reduceLine } from "./machine";

const REGISTER_DEADLINE_MS = 45_000;

interface Deps {
  backend: Backend;
  store: StateStore;
  vault: Vault;
  hasActiveCall(): boolean;
  /** The router answered a refresh with an OTP challenge instead of credentials. */
  onOtpChallenge(session: { cookie: string; sentTo: string; address: string }): void;
  /** The router no longer has this device on its whitelist; no code has been sent. */
  onNotAuthorised(address: string): void;
}

/** Runs the effects the line state machine asks for. */
export class LineController {
  private state: LineState = SIGNED_OUT;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private attemptId = 0;
  private pendingNetworkChange = false;
  /** A registration failure that arrived during a call, handled once the call ends. */
  private pendingFailure: string | null = null;
  /** Credentials for the current registration. Memory only. */
  private line: ProvisionedLine | null = null;

  constructor(private readonly deps: Deps) {}

  get status(): LineState["status"] {
    return this.state.status;
  }

  /** The domain calls are addressed to, while registered. */
  get homeDomain(): string {
    return this.line?.homeDomain ?? "";
  }

  dispatch(event: LineEvent): void {
    const step = reduceLine(this.state, event, { now: Date.now(), random: Math.random() });
    if (step.state !== this.state) {
      this.state = step.state;
      this.deps.store.update({ line: this.state });
      if (event.type !== "phase") {
        log.info("line", `${event.type} → ${this.state.status}${this.state.detail ? `: ${this.state.detail}` : ""}`);
      }
    }
    for (const effect of step.effects) this.run(effect);
  }

  /** A network change mid-call waits for the call: restarting would cut it off. */
  networkChanged(): void {
    if (this.deps.hasActiveCall()) this.pendingNetworkChange = true;
    else this.dispatch({ type: "network-changed" });
  }

  callEnded(): void {
    const failure = this.pendingFailure;
    const networkChanged = this.pendingNetworkChange;
    this.pendingFailure = null;
    this.pendingNetworkChange = false;
    if (failure !== null) this.dispatch({ type: "failed", reason: failure });
    else if (networkChanged) this.dispatch({ type: "network-changed" });
  }

  /**
   * A registered line that loses its registration mid-call keeps the engine
   * (and the call) running: the engine is told not to drop calls on a failed
   * re-REGISTER, and stopping it here would cut the call off.
   */
  private lineFailed(reason: string): void {
    if (this.state.status === "registered" && this.deps.hasActiveCall()) {
      log.warn("line", `registration lost during a call; reconnecting after it ends: ${reason}`);
      this.pendingFailure = reason;
      return;
    }
    this.dispatch({ type: "failed", reason });
  }

  handleEngineEvent(event: EngineEvent): void {
    if (event.event === "reg") {
      if (event.state === "registered") {
        this.clearDeadline();
        this.pendingFailure = null;
        this.dispatch({ type: "registered" });
      } else if (event.state === "failed") {
        this.clearDeadline();
        log.warn("line", `registration failed: ${event.code} ${event.reason}`);
        this.lineFailed(registrationFailure(event.code, event.reason));
      } else if (event.state === "unregistered") {
        this.lineFailed("The router ended this device's registration.");
      }
    } else if (event.event === "transport") {
      if (event.state === "rejected") {
        this.dispatch({ type: "failed", reason: "The device at the router's address isn't a Jio router." });
      } else if (event.state === "disconnected" && this.state.status === "registered") {
        this.lineFailed("Lost the connection to the router.");
      }
    }
  }

  handleEngineCrash(): void {
    this.clearDeadline();
    this.pendingFailure = null;
    this.dispatch({ type: "failed", reason: "The calling engine stopped unexpectedly." });
  }

  private run(effect: LineEffect): void {
    switch (effect.type) {
      case "start-attempt":
        void this.attempt();
        break;
      case "stop":
        this.attemptId++;
        this.pendingFailure = null;
        this.clearDeadline();
        this.line = null;
        void this.deps.backend.engine.stop();
        break;
      case "schedule-retry":
        this.cancelRetry();
        this.retryTimer = setTimeout(() => this.dispatch({ type: "retry-due" }), effect.delayMs);
        break;
      case "cancel-retry":
        this.cancelRetry();
        break;
    }
  }

  private async attempt(): Promise<void> {
    const id = ++this.attemptId;
    const stale = () => id !== this.attemptId;
    const { backend, store, vault } = this.deps;
    this.clearDeadline();

    try {
      const identity = vault.get();
      if (!identity) {
        this.dispatch({ type: "sign-out" });
        return;
      }

      const discovery = await discoverRouter(backend.discovery, store.get().settings.routerOverride);
      if (stale()) return;
      if (discovery.status !== "found") {
        store.update({ router: null });
        this.dispatch({ type: "failed", reason: discovery.status === "not-found" ? discovery.reason : "" });
        return;
      }
      const router = discovery.router;
      store.update({ router });

      // Refresh before every registration: the password is never stored, and
      // this is how the app learns the router has dropped this device. The
      // plain request can't make the router text anyone; only the user's
      // "Request code" click can (see onboarding.ts).
      this.dispatch({ type: "phase", phase: "refreshing" });
      const reply = await fetchCredentials(backend, router.address, identity);
      if (stale()) return;
      if (reply.kind === "otp-required") {
        this.deps.onOtpChallenge({ cookie: reply.cookie, sentTo: reply.sentTo, address: router.address });
        this.dispatch({ type: "otp-required" });
        return;
      }
      if (reply.kind === "not-authorised") {
        this.deps.onNotAuthorised(router.address);
        this.dispatch({ type: "otp-required" });
        return;
      }
      if (reply.kind === "rejected") {
        log.warn("line", `credential refresh rejected: ${reply.reason}`);
        this.dispatch({ type: "failed", reason: provisioningRefusal(reply) });
        return;
      }

      const line = reply.line;
      log.addSecret(line.password);
      log.addSecret(line.authUser);
      log.addSecret(numberFromIdentity(line.publicIdentity));
      log.addSecret(line.instanceId);
      log.addSecret(line.psoltid);

      this.dispatch({ type: "phase", phase: "registering" });
      const localAddress = await backend.localAddressFor(router.address);
      if (stale()) return;
      const hello = await backend.engine.start();
      if (stale()) return;
      store.update({
        engine: { ready: true, version: hello.engine, codecs: hello.codecs, error: "" },
      });
      const { inputDevice, outputDevice } = store.get().settings;
      await backend.engine
        .request("setDevices", { input: inputDevice, output: outputDevice })
        .catch(() => {});
      // The gateway holds a LAN registration until its own upstream one is up.
      // Armed before the request: the engine's "registered" event can be
      // handled before this await resumes, and must find the timer to clear.
      this.deadline = setTimeout(() => {
        if (!stale()) this.dispatch({ type: "failed", reason: "The router didn't answer in time." });
      }, REGISTER_DEADLINE_MS);
      this.line = line;
      await backend.engine.request("register", buildSipAccount(line, router.address, localAddress));
      if (stale()) return;
    } catch (error) {
      if (stale()) return;
      const message = error instanceof Error ? error.message : String(error);
      log.warn("line", `attempt failed: ${message}`);
      if (!(error instanceof RouterHttpError) && !backend.engine.running) {
        this.deps.store.update({
          engine: { ready: false, version: "", codecs: [], error: message },
        });
      }
      this.dispatch({ type: "failed", reason: describeFailure(error) });
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof RouterHttpError) return routerFailure(error.code);
  if (error instanceof Error && /engine/.test(error.message)) {
    return "The calling engine couldn't start.";
  }
  return "Couldn't connect to the router.";
}
