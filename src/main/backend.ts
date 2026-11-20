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
 * Fetches the line's SIP account. The plain request cannot cause an OTP text;
 * `allowEnrol` adds the `op_type=add` request, which can, so pass it only
 * when the user asked for it or this device was authorised before.
 */
export async function fetchCredentials(
  backend: Backend,
  address: string,
  identity: ProvisioningIdentity,
  allowEnrol: boolean,
): Promise<ProvisioningReply> {
  const plain = parseProvisioningReply(
    await backend.request({ address, method: "GET", path: buildProvisioningPath(identity) }),
  );
  if (plain.kind !== "rejected" || !allowEnrol) return plain;
  return enrolDevice(backend, address, identity);
}

export async function enrolDevice(
  backend: Backend,
  address: string,
  identity: ProvisioningIdentity,
): Promise<ProvisioningReply> {
  const response = await backend.request({ address, method: "GET", path: buildProvisioningPath(identity, "add") });
  const reply = parseProvisioningReply(response);
  // Names and sizes only: enough to tell how a router's enrol reply differs.
  log.info(
    "onboarding",
    `enrol reply: HTTP ${response.status} → ${reply.kind}; headers ${Object.keys(response.headers).join(",") || "none"}; body ${response.body.length} chars`,
  );
  return reply;
}

export async function submitOtp(
  backend: Backend,
  address: string,
  cookie: string,
  code: string,
): Promise<ProvisioningReply> {
  return parseProvisioningReply(
    await backend.request({ address, method: "GET", path: buildOtpPath(code), cookie }),
  );
}
