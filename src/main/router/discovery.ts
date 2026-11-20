import { execFile } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { isIPv4 } from "node:net";
import type { DiscoveryState, RouterSource } from "@shared/types";
import { log } from "../logger";
import { type RouterFailureCode, RouterHttpError, routerRequest } from "./http";
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
        reason:
          "Couldn't find the router: its name didn't resolve and this computer has no default gateway. Check that you're connected to the Jio router's network.",
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

const OWN_ROUTER_HINT =
  "If you use your own Wi-Fi router or mesh, connect to the Jio router's network, or enter its address in Settings.";

/** Why a candidate address isn't a usable Jio router, naming the address. */
export function probeFailure(address: string, code: RouterFailureCode): string {
  switch (code) {
    case "bad-certificate":
      return `The device at ${address} isn't a Jio router. ${OWN_ROUTER_HINT}`;
    case "refused":
      return `Something answered at ${address}, but no Jio calling service is running there. If the Jio router just restarted, wait a minute. ${OWN_ROUTER_HINT}`;
    case "timeout":
      return `Nothing answered at ${address}. If the Jio router just restarted, wait a minute and try again.`;
    case "unreachable":
    case "not-private":
      return `Couldn't reach ${address} from this computer.`;
    case "bad-reply":
      return `The device at ${address} sent a reply this app couldn't read.`;
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

/** Non-mutating check: TLS handshake plus an HTTP HEAD, which the gateway answers with 501. */
export async function probeRouter(address: string): Promise<ProbeResult> {
  try {
    // Generous: a router that has just restarted takes 4–6 s to answer.
    const response = await routerRequest({ address, method: "HEAD", path: "/", timeoutMs: 10_000 });
    const server = response.headers.server;
    return { ok: true, server: typeof server === "string" ? server : "" };
  } catch (error) {
    log.warn("discovery", `probe of ${address} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof RouterHttpError) return { ok: false, reason: probeFailure(address, error.code) };
    return { ok: false, reason: `Couldn't reach ${address} from this computer.` };
  }
}

/**
 * Windows: ask the routing table directly. `default-gateway` shells out to
 * wmic, which recent Windows 11 releases no longer install.
 */
function windowsGateway(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop",
      ],
      { windowsHide: true, timeout: 8000 },
      (error, stdout) => {
        const address = String(stdout).trim();
        resolve(!error && isIPv4(address) && address !== "0.0.0.0" ? address : null);
      },
    );
  });
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
      if (process.platform === "win32") {
        const address = await windowsGateway();
        if (address) return address;
      }
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
