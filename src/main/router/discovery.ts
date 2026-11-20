import dgram from "node:dgram";
import dns from "node:dns/promises";
import { isIPv4 } from "node:net";
import type { DiscoveryState, RouterSource } from "@shared/types";
import { log } from "../logger";
import { RouterHttpError, routerRequest } from "./http";
import { isPrivateIPv4 } from "./net";
import { ROUTER_HOSTNAME } from "./provisioning";

export type ProbeResult = { ok: true; server: string } | { ok: false; reason: string };

export interface DiscoveryDeps {
  /** IPv4 addresses for a host name, [] when it does not resolve. */
  resolve4(hostname: string): Promise<string[]>;
  /** The default IPv4 gateway, or null when there is none. */
  gateway4(): Promise<string | null>;
  /** Checks that the voice gateway answers on the provisioning port. */
  probe(address: string): Promise<ProbeResult>;
}

interface Candidate {
  address: string;
  source: RouterSource;
}

/**
 * Finds the router's voice gateway. Order: the user's override, then
 * jiofiber.local.html as the router's own DNS answers it, then the default
 * gateway. Requests always carry the jiofiber.local.html name even when the
 * address came from the gateway, the way `curl --resolve` would.
 */
export async function discoverRouter(deps: DiscoveryDeps, override = ""): Promise<DiscoveryState> {
  const candidates: Candidate[] = [];
  const add = (address: string, source: RouterSource) => {
    if (isPrivateIPv4(address) && !candidates.some((c) => c.address === address)) {
      candidates.push({ address, source });
    }
  };

  const manual = override.trim();
  if (manual !== "") {
    if (isIPv4(manual)) add(manual, "manual");
    else for (const address of await deps.resolve4(manual)) add(address, "manual");
    if (candidates.length === 0) {
      return {
        status: "not-found",
        reason: "The router address in Settings isn't a device on your local network.",
        tried: [manual],
      };
    }
  } else {
    for (const address of await deps.resolve4(ROUTER_HOSTNAME)) add(address, "dns");
    const gateway = await deps.gateway4();
    if (gateway) add(gateway, "gateway");
    if (candidates.length === 0) {
      return {
        status: "not-found",
        reason: "This computer isn't connected to a network.",
        tried: [],
      };
    }
  }

  let lastReason = "";
  for (const candidate of candidates) {
    const result = await deps.probe(candidate.address);
    if (result.ok) {
      return { status: "found", router: { ...candidate, server: result.server } };
    }
    lastReason = result.reason;
  }
  return {
    status: "not-found",
    reason: lastReason || "No Jio router answered on this network.",
    tried: candidates.map((c) => c.address),
  };
}

/** Non-mutating check: TLS handshake plus an HTTP HEAD, which the gateway answers with 501. */
export async function probeRouter(address: string): Promise<ProbeResult> {
  try {
    const response = await routerRequest({ address, method: "HEAD", path: "/", timeoutMs: 6000 });
    const server = response.headers.server;
    return { ok: true, server: typeof server === "string" ? server : "" };
  } catch (error) {
    log.warn("discovery", `probe of ${address} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof RouterHttpError) {
      if (error.code === "bad-certificate") {
        return { ok: false, reason: "The device at the gateway address isn't a Jio router." };
      }
      if (error.code === "timeout") {
        return { ok: false, reason: "The router didn't answer. Its calling service may be starting up." };
      }
      return { ok: false, reason: "The router's calling service isn't reachable from this network." };
    }
    return { ok: false, reason: "The router's calling service isn't reachable from this network." };
  }
}

/** Logs how long a discovery step took; slow steps are the usual cause of a slow start. */
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    log.info("discovery", `${label} took ${Math.round(performance.now() - started)} ms`);
  }
}

export const systemDiscoveryDeps: DiscoveryDeps = {
  resolve4: (hostname) =>
    timed("name lookup", async () => {
      try {
        const records = await dns.lookup(hostname, { family: 4, all: true });
        return records.map((record) => record.address);
      } catch {
        return [];
      }
    }),
  gateway4: () =>
    timed("gateway lookup", async () => {
      try {
        const { gateway4async } = await import("default-gateway");
        return (await gateway4async()).gateway;
      } catch {
        return null;
      }
    }),
  probe: (address) => timed("router probe", () => probeRouter(address)),
};

/** The local IPv4 address this machine uses to reach the router. Sends nothing. */
export function localAddressFor(routerAddress: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.connect(9, routerAddress, () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}
