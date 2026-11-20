import type { LinePhase, LineState } from "@shared/types";

/**
 * The line's connection lifecycle as a pure reducer. One "attempt" is the
 * whole sequence the router requires: find it, refresh credentials over
 * port 8443, then register. The controller performs the returned effects.
 */

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;

/**
 * Exponential backoff with jitter: 5 s doubling to a 5 minute ceiling, each
 * delay drawn from the upper half of its window so clients that failed
 * together do not retry together.
 */
export function backoffDelay(attempt: number, random: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(ceiling * (0.5 + 0.5 * Math.min(1, Math.max(0, random))));
}

export type LineEvent =
  | { type: "sign-in" }
  | { type: "sign-out" }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "phase"; phase: LinePhase }
  | { type: "registered" }
  | { type: "failed"; reason: string }
  | { type: "otp-required" }
  | { type: "retry-due" }
  | { type: "network-changed" };

export type LineEffect =
  | { type: "start-attempt" }
  | { type: "stop" }
  | { type: "schedule-retry"; delayMs: number }
  | { type: "cancel-retry" };

export interface LineContext {
  now: number;
  /** A value in [0, 1) for jitter. */
  random: number;
}

export const SIGNED_OUT: LineState = { status: "signed-out", detail: "", attempt: 0 };

interface Step {
  state: LineState;
  effects: LineEffect[];
}

const stay = (state: LineState): Step => ({ state, effects: [] });

function beginAttempt(attempt: number): Step {
  return {
    state: { status: "connecting", phase: "finding-router", detail: "", attempt },
    effects: [{ type: "cancel-retry" }, { type: "start-attempt" }],
  };
}

export function reduceLine(state: LineState, event: LineEvent, context: LineContext): Step {
  switch (event.type) {
    case "sign-out":
      return { state: SIGNED_OUT, effects: [{ type: "cancel-retry" }, { type: "stop" }] };

    case "sign-in":
    case "connect":
      if (event.type === "connect" && state.status === "signed-out") return stay(state);
      return beginAttempt(0);

    case "disconnect":
      if (state.status === "signed-out") return stay(state);
      return {
        state: { status: "offline", detail: "", attempt: 0 },
        effects: [{ type: "cancel-retry" }, { type: "stop" }],
      };

    case "phase":
      if (state.status !== "connecting") return stay(state);
      return stay({ ...state, phase: event.phase });

    case "registered":
      if (state.status !== "connecting" && state.status !== "registered") return stay(state);
      return stay({ status: "registered", detail: "", attempt: 0 });

    case "failed": {
      if (state.status !== "connecting" && state.status !== "registered") return stay(state);
      // A line that was up gets one quick retry before backing off.
      const attempt = state.status === "registered" ? 0 : state.attempt;
      const delayMs = backoffDelay(attempt, context.random);
      return {
        state: {
          status: "retrying",
          detail: event.reason,
          attempt: attempt + 1,
          retryAt: context.now + delayMs,
        },
        effects: [{ type: "stop" }, { type: "schedule-retry", delayMs }],
      };
    }

    case "otp-required":
      if (state.status !== "connecting") return stay(state);
      // The device must be confirmed with a code, which only the user may
      // request. Don't retry on a timer; a new network or "Connect" checks again.
      return {
        state: {
          status: "needs-otp",
          detail: "The router no longer recognises this device.",
          attempt: 0,
        },
        effects: [{ type: "cancel-retry" }, { type: "stop" }],
      };

    case "retry-due":
      if (state.status !== "retrying") return stay(state);
      return beginAttempt(state.attempt);

    case "network-changed":
      // A new network is a fresh start; a manual or signed-out state stays put.
      // needs-otp checks again too: attempts only send the plain request, which
      // can't text anyone, and the device may be back on a router that knows it.
      if (
        state.status === "retrying" ||
        state.status === "registered" ||
        state.status === "connecting" ||
        state.status === "needs-otp"
      ) {
        return beginAttempt(0);
      }
      return stay(state);
  }
}
