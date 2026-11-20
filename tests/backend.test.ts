import { describe, expect, it, vi } from "vitest";

vi.mock("../src/main/logger", () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, addSecret: () => {} } }));

const { fetchCredentials } = await import("../src/main/backend");
type Backend = import("../src/main/backend").Backend;

describe("credential refresh", () => {
  it("never asks the router to add the device, whatever the plain reply was", async () => {
    // Each op_type=add can make the router text the line's owner; a refresh
    // runs unattended (and on other people's Jio networks), so it must not.
    for (const reply of [
      { status: 200, headers: {}, body: '<wap-provisioningdoc version="1"></wap-provisioningdoc>' },
      { status: 503, headers: {}, body: "" },
      { status: 200, headers: {}, body: "" },
    ]) {
      const paths: string[] = [];
      const backend = {
        request: async ({ path }: { path: string }) => {
          paths.push(path);
          return reply;
        },
      } as unknown as Backend;
      await fetchCredentials(backend, "192.168.29.1", { deviceId: "02:1a:2b:3c:4d:5e", deviceName: "Desk" });
      expect(paths).toHaveLength(1);
      expect(new URL(`https://router${paths[0]}`).searchParams.has("op_type")).toBe(false);
    }
  });
});
