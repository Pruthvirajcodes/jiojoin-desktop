import { describe, expect, it } from "vitest";
import { type DiscoveryDeps, discoverRouter } from "../src/main/router/discovery";
import { isPrivateIPv4 } from "../src/main/router/net";

function deps(overrides: Partial<DiscoveryDeps> & { probed?: string[] } = {}): DiscoveryDeps {
  return {
    resolve4: async () => [],
    gateway4: async () => null,
    probe: async (address) => {
      overrides.probed?.push(address);
      return { ok: true, server: "JIDU6911/JUICEJFV-1.5.5" };
    },
    ...overrides,
  };
}

describe("router discovery", () => {
  it("uses the address jiofiber.local.html resolves to", async () => {
    const result = await discoverRouter(
      deps({ resolve4: async () => ["192.168.29.1"], gateway4: async () => "192.168.29.1" }),
    );
    expect(result).toEqual({
      status: "found",
      router: { address: "192.168.29.1", source: "dns", server: "JIDU6911/JUICEJFV-1.5.5" },
    });
  });

  it("falls back to the default gateway when the name does not resolve", async () => {
    const result = await discoverRouter(deps({ gateway4: async () => "192.168.31.1" }));
    expect(result).toMatchObject({ status: "found", router: { address: "192.168.31.1", source: "gateway" } });
  });

  it("tries the gateway when the resolved address does not answer", async () => {
    const probed: string[] = [];
    const result = await discoverRouter(
      deps({
        resolve4: async () => ["192.168.1.1"],
        gateway4: async () => "192.168.31.1",
        probe: async (address) => {
          probed.push(address);
          return address === "192.168.31.1"
            ? { ok: true, server: "" }
            : { ok: false, reason: "unreachable" };
        },
      }),
    );
    expect(probed).toEqual(["192.168.1.1", "192.168.31.1"]);
    expect(result).toMatchObject({ status: "found", router: { source: "gateway" } });
  });

  it("never probes a public address, even if DNS returns one", async () => {
    const probed: string[] = [];
    const result = await discoverRouter(
      deps({ resolve4: async () => ["93.184.216.34"], gateway4: async () => "8.8.8.8", probed }),
    );
    expect(probed).toEqual([]);
    expect(result.status).toBe("not-found");
  });

  it("prefers a manual override and reports when it is unusable", async () => {
    const probed: string[] = [];
    const found = await discoverRouter(
      deps({ resolve4: async () => ["192.168.29.1"], probed }),
      " 10.0.0.1 ",
    );
    expect(probed).toEqual(["10.0.0.1"]);
    expect(found).toMatchObject({ status: "found", router: { address: "10.0.0.1", source: "manual" } });

    const bad = await discoverRouter(deps(), "1.1.1.1");
    expect(bad).toMatchObject({ status: "not-found", tried: ["1.1.1.1"] });
  });

  it("reports the last probe failure when nothing answers", async () => {
    const result = await discoverRouter(
      deps({
        gateway4: async () => "192.168.0.1",
        probe: async () => ({ ok: false, reason: "The device at the gateway address isn't a Jio router." }),
      }),
    );
    expect(result).toEqual({
      status: "not-found",
      reason: "The device at the gateway address isn't a Jio router.",
      tried: ["192.168.0.1"],
    });
  });

  it("recognises private IPv4 ranges", () => {
    for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.31.1", "169.254.1.1", "100.64.0.1"]) {
      expect(isPrivateIPv4(address), address).toBe(true);
    }
    for (const address of ["172.32.0.1", "192.169.1.1", "8.8.8.8", "fe80::1", "router.local", ""]) {
      expect(isPrivateIPv4(address), address).toBe(false);
    }
  });
});
