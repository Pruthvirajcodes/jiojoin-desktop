import { describe, expect, it } from "vitest";
import type { LineState } from "../src/shared/types";
import {
  BACKOFF_MAX_MS,
  type LineEvent,
  SIGNED_OUT,
  backoffDelay,
  reduceLine,
} from "../src/main/line/machine";

const context = { now: 1_000_000, random: 1 };

function run(events: LineEvent[], from: LineState = SIGNED_OUT) {
  let state = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = reduceLine(state, event, context);
    state = step.state;
    effects.push(...step.effects.map((effect) => effect.type));
  }
  return { state, effects };
}

describe("backoff", () => {
  it("doubles from 5 s to a 5 minute ceiling", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => backoffDelay(attempt, 1))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ]);
  });

  it("jitters within the upper half of the window", () => {
    expect(backoffDelay(2, 0)).toBe(10_000);
    expect(backoffDelay(2, 0.5)).toBe(15_000);
    expect(backoffDelay(50, 0)).toBe(BACKOFF_MAX_MS / 2);
    expect(backoffDelay(-3, 2)).toBe(5_000);
  });
});

describe("line state machine", () => {
  it("connects after sign-in and reports each phase", () => {
    const { state, effects } = run([
      { type: "sign-in" },
      { type: "phase", phase: "refreshing" },
      { type: "phase", phase: "registering" },
    ]);
    expect(state).toEqual({ status: "connecting", phase: "registering", detail: "", attempt: 0 });
    expect(effects).toEqual(["cancel-retry", "start-attempt"]);
    expect(run([{ type: "sign-in" }, { type: "registered" }]).state).toEqual({
      status: "registered",
      detail: "",
      attempt: 0,
    });
  });

  it("backs off further on each failed attempt and keeps the reason", () => {
    let state = run([{ type: "sign-in" }]).state;
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const failed = reduceLine(state, { type: "failed", reason: "The router didn't answer in time." }, context);
      expect(failed.state).toMatchObject({ status: "retrying", detail: "The router didn't answer in time." });
      expect(failed.effects[0]).toEqual({ type: "stop" });
      const retry = failed.effects.find((effect) => effect.type === "schedule-retry");
      if (retry?.type !== "schedule-retry") throw new Error("expected a retry");
      delays.push(retry.delayMs);
      expect(failed.state.retryAt).toBe(context.now + retry.delayMs);
      state = reduceLine(failed.state, { type: "retry-due" }, context).state;
      expect(state.status).toBe("connecting");
    }
    expect(delays).toEqual([5_000, 10_000, 20_000]);
  });

  it("retries quickly when an established registration drops", () => {
    const registered = run([{ type: "sign-in" }, { type: "registered" }]).state;
    const step = reduceLine(registered, { type: "failed", reason: "Lost the connection to the router." }, context);
    expect(step.state).toMatchObject({ status: "retrying", attempt: 1 });
    expect(step.effects).toContainEqual({ type: "schedule-retry", delayMs: 5_000 });
  });

  it("resets the backoff after a successful registration", () => {
    const { state } = run([
      { type: "sign-in" },
      { type: "failed", reason: "x" },
      { type: "retry-due" },
      { type: "failed", reason: "x" },
      { type: "retry-due" },
      { type: "registered" },
    ]);
    expect(state.attempt).toBe(0);
  });

  it("stops retrying on a timer when the device needs confirming, but checks again on a new network", () => {
    const { state, effects } = run([{ type: "sign-in" }, { type: "otp-required" }, { type: "retry-due" }]);
    expect(state.status).toBe("needs-otp");
    expect(effects.filter((effect) => effect === "start-attempt")).toHaveLength(1);
    // Attempts only send the plain request, which can't text anyone.
    expect(reduceLine(state, { type: "network-changed" }, context).state.status).toBe("connecting");
    expect(reduceLine(state, { type: "connect" }, context).state.status).toBe("connecting");
  });

  it("reconnects from scratch when the network changes", () => {
    for (const events of [
      [{ type: "sign-in" }, { type: "registered" }],
      [{ type: "sign-in" }, { type: "failed", reason: "x" }, { type: "retry-due" }, { type: "failed", reason: "x" }],
      [{ type: "sign-in" }, { type: "phase", phase: "registering" }],
    ] satisfies LineEvent[][]) {
      const before = run(events).state;
      const step = reduceLine(before, { type: "network-changed" }, context);
      expect(step.state).toEqual({ status: "connecting", phase: "finding-router", detail: "", attempt: 0 });
      expect(step.effects.map((effect) => effect.type)).toEqual(["cancel-retry", "start-attempt"]);
    }
  });

  it("stays offline after a manual disconnect until the user reconnects", () => {
    const offline = run([{ type: "sign-in" }, { type: "registered" }, { type: "disconnect" }]);
    expect(offline.state.status).toBe("offline");
    expect(offline.effects.slice(-2)).toEqual(["cancel-retry", "stop"]);
    for (const event of [
      { type: "network-changed" },
      { type: "retry-due" },
      { type: "failed", reason: "x" },
      { type: "registered" },
    ] satisfies LineEvent[]) {
      expect(reduceLine(offline.state, event, context)).toEqual({ state: offline.state, effects: [] });
    }
    expect(reduceLine(offline.state, { type: "connect" }, context).state.status).toBe("connecting");
  });

  it("ignores everything except sign-in while signed out", () => {
    for (const event of [
      { type: "connect" },
      { type: "disconnect" },
      { type: "network-changed" },
      { type: "retry-due" },
      { type: "registered" },
    ] satisfies LineEvent[]) {
      expect(reduceLine(SIGNED_OUT, event, context).state).toBe(SIGNED_OUT);
    }
    const signedOut = run([{ type: "sign-in" }, { type: "registered" }, { type: "sign-out" }]);
    expect(signedOut.state).toEqual(SIGNED_OUT);
    expect(signedOut.effects.slice(-2)).toEqual(["cancel-retry", "stop"]);
  });
});
