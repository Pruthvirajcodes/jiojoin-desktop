import { randomUUID } from "node:crypto";
import { canonicalNumber, toDialString } from "@shared/phone";
import type { ActionResult, CallInfo, CallState } from "@shared/types";
import type { Backend } from "../backend";
import type { EngineEvent } from "../engine/protocol";
import { log } from "../logger";
import { outgoingFailure } from "../reasons";
import { buildDialUri } from "../router/provisioning";
import type { HistoryStore } from "../store/history";
import type { StateStore } from "../store/state";

type EngineCallEvent = Extract<EngineEvent, { event: "call" }>;

const MICROPHONE_HELP =
  "JioJoin can't use the microphone. Allow it in your system's privacy settings, then try again.";

interface Deps {
  backend: Backend;
  store: StateStore;
  history: HistoryStore;
  /** "" unless the line is registered. */
  homeDomain(): string;
  onIncoming(call: CallInfo): void;
  onCallOver(call: CallInfo): void;
}

const STATE_MAP: Record<EngineCallEvent["state"], CallState> = {
  calling: "dialing",
  ringing: "ringing",
  incoming: "incoming",
  connecting: "connecting",
  active: "active",
  ended: "ended",
};

/** Owns the one call the app can have at a time, and writes its history entry. */
export class CallsController {
  private call: CallInfo | null = null;
  private endedByUser = false;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: Deps) {}

  get active(): boolean {
    return this.call !== null && this.call.state !== "ended";
  }

  async dial(raw: string): Promise<ActionResult> {
    if (this.active) return { ok: false, error: "You're already on a call." };
    const homeDomain = this.deps.homeDomain();
    if (homeDomain === "") {
      return { ok: false, error: "Your line isn't connected yet. Try again in a moment." };
    }
    const target = toDialString(raw);
    if (!target.ok) return { ok: false, error: target.reason };
    if (!(await this.deps.backend.ensureMicrophone())) return { ok: false, error: MICROPHONE_HELP };

    this.setCall({
      id: randomUUID(),
      direction: "outgoing",
      number: canonicalNumber(target.dial),
      name: "",
      state: "dialing",
      startedAt: Date.now(),
      muted: false,
      held: false,
      remoteHeld: false,
      codec: "",
      endReason: "",
      failed: false,
    });
    this.endedByUser = false;

    try {
      await this.deps.backend.engine.request("dial", {
        uri: buildDialUri(target.dial, homeDomain),
        number: target.dial,
      });
      return { ok: true };
    } catch (error) {
      log.warn("call", `dial failed: ${error instanceof Error ? error.message : String(error)}`);
      this.finish({ text: "The call couldn't be started", failed: true });
      return { ok: true };
    }
  }

  async answer(): Promise<void> {
    if (this.call?.state !== "incoming") return;
    if (!(await this.deps.backend.ensureMicrophone())) {
      log.warn("call", "answer blocked: microphone access denied");
      return;
    }
    await this.deps.backend.engine.request("answer").catch(() => {});
  }

  async hangup(): Promise<void> {
    if (!this.active) return;
    this.endedByUser = true;
    await this.deps.backend.engine.request("hangup").catch(() => {
      // The engine no longer knows the call; close it out locally.
      this.finish({ text: "Call ended", failed: false });
    });
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.call || !this.active) return;
    await this.deps.backend.engine.request("mute", { on: muted }).catch(() => {});
    if (this.call) this.setCall({ ...this.call, muted });
  }

  async setHold(held: boolean): Promise<void> {
    if (this.call?.state !== "active") return;
    await this.deps.backend.engine.request("hold", { on: held }).catch(() => {});
  }

  async sendDtmf(digits: string): Promise<void> {
    if (this.call?.state !== "active" || !/^[0-9*#]{1,32}$/.test(digits)) return;
    await this.deps.backend.engine.request("dtmf", { digits }).catch(() => {});
  }

  /** Clears the "call ended" summary early. */
  dismiss(): void {
    if (this.call?.state === "ended") this.setCall(null);
  }

  handleEngineEvent(event: EngineEvent): void {
    if (event.event === "busyReject") {
      this.deps.history.add({
        kind: "missed",
        number: canonicalNumber(event.number),
        name: event.name,
        at: Date.now(),
        durationSec: 0,
        reason: "Called while you were on another call",
      });
      return;
    }
    if (event.event !== "call") return;

    if (!this.call || this.call.state === "ended") {
      if (event.direction !== "in" || event.state === "ended") return;
      this.endedByUser = false;
      this.setCall({
        id: randomUUID(),
        direction: "incoming",
        number: canonicalNumber(event.number),
        name: event.name,
        state: "incoming",
        startedAt: Date.now(),
        muted: false,
        held: false,
        remoteHeld: false,
        codec: "",
        endReason: "",
        failed: false,
      });
      if (this.call) this.deps.onIncoming(this.call);
      return;
    }

    if (event.state === "ended") {
      this.finishFromEngine(event);
      return;
    }

    const state = STATE_MAP[event.state];
    this.setCall({
      ...this.call,
      state,
      held: event.held,
      remoteHeld: event.remoteHeld,
      muted: event.muted,
      codec: event.codec ?? this.call.codec,
      answeredAt: state === "active" ? (this.call.answeredAt ?? Date.now()) : this.call.answeredAt,
    });
  }

  handleEngineStopped(): void {
    if (this.active) this.finish({ text: "The call was cut off", failed: true });
  }

  private finishFromEngine(event: EngineCallEvent): void {
    const call = this.call;
    if (!call) return;
    if (call.answeredAt) {
      this.finish({ text: "Call ended", failed: false });
    } else if (call.direction === "incoming") {
      this.finish({ text: this.endedByUser ? "Call declined" : "Missed call", failed: false });
    } else if (this.endedByUser) {
      this.finish({ text: "Call cancelled", failed: false });
    } else {
      log.info("call", `outgoing call ended: ${event.code} ${event.reason}`);
      this.finish(outgoingFailure(event.code));
    }
  }

  private finish(outcome: { text: string; failed: boolean }): void {
    const call = this.call;
    if (!call || call.state === "ended") return;
    const endedAt = Date.now();
    const durationSec = call.answeredAt ? Math.round((endedAt - call.answeredAt) / 1000) : 0;
    const missed = call.direction === "incoming" && !call.answeredAt && !this.endedByUser;

    this.deps.history.add({
      kind: missed ? "missed" : outcome.failed ? "failed" : call.direction,
      number: call.number,
      name: call.name,
      at: call.startedAt,
      durationSec,
      reason: call.answeredAt ? "" : outcome.text,
    });

    const ended: CallInfo = {
      ...call,
      state: "ended",
      endedAt,
      endReason: outcome.text,
      failed: outcome.failed,
      held: false,
      remoteHeld: false,
    };
    this.setCall(ended);
    this.deps.onCallOver(ended);
    // Leave the outcome on screen briefly; a failure needs longer to read.
    this.clearTimer = setTimeout(() => this.dismiss(), outcome.failed ? 6000 : 2000);
  }

  private setCall(call: CallInfo | null): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    this.call = call;
    this.deps.store.update({ call });
  }
}
