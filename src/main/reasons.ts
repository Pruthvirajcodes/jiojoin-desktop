/**
 * Plain-language explanations for everything that can go wrong. Nothing here
 * names a protocol. Each failure type is mapped exhaustively, so adding one
 * breaks the build until it has an honest message.
 */
import type { RouterFailureCode } from "./router/http";
import type { ProvisioningReply } from "./router/provisioning";

const exhausted = (value: never): never => {
  throw new Error(`unhandled failure: ${String(value)}`);
};

/** A request to the router's provisioning service failed. */
export function routerFailure(code: RouterFailureCode): string {
  switch (code) {
    case "not-private":
      return "The router address isn't on your local network.";
    case "refused":
      return "The router is there, but its calling service isn't running. If it just restarted, wait a minute and try again.";
    case "unreachable":
      return "Couldn't reach the router. Check that this computer is on the Jio router's network.";
    case "timeout":
      return "The router didn't answer in time. If it just restarted, wait a minute and try again.";
    case "bad-certificate":
      return "The device at the router's address isn't a Jio router.";
    case "bad-reply":
      return "The router sent a reply this app couldn't read.";
    default:
      return exhausted(code);
  }
}

/** The router answered a provisioning request but gave no usable account. */
export function provisioningRefusal(reply: Extract<ProvisioningReply, { kind: "rejected" }>): string {
  if (reply.status !== 200) return `The router refused the request (HTTP ${reply.status}).`;
  return "The router's reply didn't include this line's details.";
}

export function registrationFailure(code: number, reason: string): string {
  // Local socket errors arrive with a synthetic code (often 503), so the
  // reason text decides first: "Connection refused" is the router, not Jio.
  if (/refused/i.test(reason)) return "The router's calling service refused the connection. It may be restarting.";
  if (/unreach|no route|network is down/i.test(reason)) return "The network isn't reachable.";
  if (code === 408 || /timed? ?out/i.test(reason)) return "The router didn't answer in time.";
  if (code === 401 || code === 403 || code === 407) {
    return "The router rejected this device's sign-in details.";
  }
  if (code === 423) return "The router refused the registration interval.";
  if (code === 480 || code === 500 || code === 502 || code === 503 || code === 504) {
    return "Jio's voice service isn't available right now.";
  }
  if (code >= 400) return `The router refused the registration (code ${code}).`;
  return "Couldn't reach the router's calling service.";
}

export interface CallOutcome {
  text: string;
  failed: boolean;
}

/** How an outgoing call that never connected should be described. */
export function outgoingFailure(code: number): CallOutcome {
  switch (code) {
    case 486:
    case 600:
      return { text: "Busy", failed: true };
    case 603:
      return { text: "Call declined", failed: true };
    case 480:
      return { text: "Not reachable right now", failed: true };
    case 408:
      return { text: "No answer", failed: true };
    case 404:
    case 604:
      return { text: "This number doesn't exist", failed: true };
    case 484:
      return { text: "The number is incomplete", failed: true };
    case 403:
      return { text: "This call isn't allowed on your line", failed: true };
    case 488:
    case 606:
      return { text: "The other side can't take this kind of call", failed: true };
    case 487:
      return { text: "Call cancelled", failed: false };
    case 500:
    case 502:
    case 503:
    case 504:
      return { text: "The network couldn't complete the call", failed: true };
    default:
      if (code >= 400) return { text: `The call couldn't be completed (code ${code})`, failed: true };
      return { text: "Call ended", failed: false };
  }
}
