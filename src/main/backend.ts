import type { Engine } from "./engine/process";
import { log } from "./logger";
import type { DiscoveryDeps } from "./router/discovery";
import type { RouterResponse } from "./router/http";
import {
  type ProvisioningIdentity,
  type ProvisioningReply,
  buildOtpPath,
  buildProvisioningPath,
  parseProvisioningReply,
} from "./router/provisioning";

/** Everything that touches the outside world, so demo mode can replace it whole. */
export interface Backend {
  discovery: DiscoveryDeps;
  request(options: {
    address: string;
    method: "GET" | "HEAD";
    path: string;
    cookie?: string;
  }): Promise<RouterResponse>;
  localAddressFor(routerAddress: string): Promise<string>;
  engine: Engine;
  /** Resolves false when the OS denies microphone access. */
  ensureMicrophone(): Promise<boolean>;
}

/**
 * Fetches the line's SIP account with the plain request, which can never make
 * the router text a code. Only `enrolDevice` (an explicit user action) can.
 */
export async function fetchCredentials(
  backend: Backend,
  address: string,
  identity: ProvisioningIdentity,
): Promise<ProvisioningReply> {
  const response = await backend.request({ address, method: "GET", path: buildProvisioningPath(identity) });
  const reply = parseProvisioningReply(response);
  if (reply.kind !== "config") logReplyShape("refresh", response, reply);
  return reply;
}

export async function enrolDevice(
  backend: Backend,
  address: string,
  identity: ProvisioningIdentity,
): Promise<ProvisioningReply> {
  const response = await backend.request({ address, method: "GET", path: buildProvisioningPath(identity, "add") });
  const reply = parseProvisioningReply(response);
  logReplyShape("enrol", response, reply);
  return reply;
}

/** Names and sizes only: enough to tell how a router's replies differ, nothing secret. */
function logReplyShape(label: string, response: RouterResponse, reply: ProvisioningReply): void {
  log.info(
    "onboarding",
    `${label} reply: HTTP ${response.status} → ${reply.kind}${reply.kind === "rejected" ? ` (${reply.reason})` : ""}; headers ${Object.keys(response.headers).join(",") || "none"}; body ${response.body.length} chars`,
  );
}

export async function submitOtp(
  backend: Backend,
  address: string,
  cookie: string,
  code: string,
): Promise<ProvisioningReply> {
  const response = await backend.request({ address, method: "GET", path: buildOtpPath(code), cookie });
  const reply = parseProvisioningReply(response);
  if (reply.kind !== "config") logReplyShape("code", response, reply);
  return reply;
}
