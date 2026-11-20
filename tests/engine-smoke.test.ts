import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineProcess } from "../src/main/engine/process";

const binary =
  process.env.JIOJOIN_ENGINE_PATH ??
  join(
    import.meta.dirname,
    "..",
    "engine",
    "dist",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "jiojoin-engine.exe" : "jiojoin-engine",
  );

// Needs the native engine: run `bun run engine:build` first.
describe.skipIf(!existsSync(binary))("engine sidecar", () => {
  it("starts, answers its handshake, and has TLS and both AMR codecs", async () => {
    process.env.JIOJOIN_ENGINE_NULL_AUDIO = "1";
    const engine = new EngineProcess(binary);
    try {
      const hello = await engine.start();
      expect(hello.protocol).toBe(1);
      expect(hello.pjsip).toBe("2.17");
      expect(hello.tls).toBe(true);
      // Priority order matters: wideband first, then narrowband, then G.711.
      expect(hello.codecs).toEqual(["AMR-WB/16000/1", "AMR/8000/1", "PCMU/8000/1"]);

      const devices = await engine.request<{ devices: unknown[] }>("devices");
      expect(Array.isArray(devices.devices)).toBe(true);

      await expect(engine.request("dial", { uri: "sip:100@example.invalid" })).rejects.toThrow("not registered");
      await expect(engine.request("nonsense")).rejects.toThrow("unknown command");
    } finally {
      await engine.stop();
    }
    expect(engine.running).toBe(false);
  });

  it("exits on its own when its parent's pipe closes", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.stdin.end();
    expect(await exited).toBe(0);
  });
});
