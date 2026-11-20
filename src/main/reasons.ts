/** Plain-language explanations for SIP outcomes. Nothing here names a protocol. */

export function registrationFailure(code: number, reason: string): string {
  if (code === 401 || code === 403 || code === 407) {
    return "The router rejected this device's sign-in details.";
  }
  if (code === 408 || /timed? ?out/i.test(reason)) return "The router didn't answer in time.";
  if (code === 423) return "The router refused the registration interval.";
  if (code === 480 || code === 500 || code === 502 || code === 503 || code === 504) {
    return "Jio's voice service isn't available right now.";
  }
  if (code >= 400) return `The router refused the registration (code ${code}).`;
  if (/refused/i.test(reason)) return "The router refused the connection.";
  if (/unreach|no route|network is down/i.test(reason)) return "The network isn't reachable.";
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
