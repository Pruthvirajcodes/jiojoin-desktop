import { describe, expect, it, vi } from "vitest";
import { type EngineEvent, EngineProtocol, LineSplitter } from "../src/main/engine/protocol";

function setup() {
  const written: string[] = [];
  const events: EngineEvent[] = [];
  const protocol = new EngineProtocol(
    (line) => written.push(line),
    (event) => events.push(event),
  );
  return { protocol, written, events };
}

describe("engine protocol", () => {
  it("splits lines across chunk boundaries", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(":2}\r\n\n")).toEqual(['{"b":2}']);
    expect(splitter.push("")).toEqual([]);
  });

  it("writes one JSON command per line and resolves the matching reply", async () => {
    const { protocol, written } = setup();
    const hello = protocol.request("hello");
    const dial = protocol.request("dial", { uri: "sip:1@x" });
    expect(written.map((line) => JSON.parse(line))).toEqual([
      { id: 1, cmd: "hello" },
      { id: 2, cmd: "dial", uri: "sip:1@x" },
    ]);
    expect(written.every((line) => line.endsWith("\n") && line.indexOf("\n") === line.length - 1)).toBe(true);

    // Replies may arrive out of order and split mid-line.
    protocol.receive('{"id":2,"ok":true,"callId":0}\n{"id":1,"ok":tr');
    protocol.receive('ue,"engine":"1.0.0","protocol":1,"tls":true,"codecs":["AMR-WB/16000/1"]}\n');
    await expect(dial).resolves.toMatchObject({ callId: 0 });
    await expect(hello).resolves.toMatchObject({ engine: "1.0.0", tls: true });
  });

  it("rejects with the engine's error message", async () => {
    const { protocol } = setup();
    const request = protocol.request("dial", { uri: "x" });
    protocol.receive('{"id":1,"ok":false,"error":"invalid number"}\n');
    await expect(request).rejects.toThrow("invalid number");
  });

  it("delivers events and ignores noise", () => {
    const { protocol, events } = setup();
    protocol.receive('garbage\n{"event":"ready","protocol":1,"engine":"1.0.0"}\n[1,2]\n{"id":99,"ok":true}\n');
    protocol.receive('{"event":"reg","state":"registered","code":200,"reason":"OK","expires":3600}\n');
    expect(events).toEqual([
      { event: "ready", protocol: 1, engine: "1.0.0" },
      { event: "reg", state: "registered", code: 200, reason: "OK", expires: 3600 },
    ]);
  });

  it("times out a command the engine never answers", async () => {
    vi.useFakeTimers();
    try {
      const { protocol } = setup();
      const request = protocol.request("register", {}, 5000);
      const assertion = expect(request).rejects.toThrow('engine did not answer "register"');
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      // A late reply is dropped quietly.
      protocol.receive('{"id":1,"ok":true}\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails pending and future requests once the engine is gone", async () => {
    const { protocol, written } = setup();
    const pending = protocol.request("hello");
    protocol.close();
    await expect(pending).rejects.toThrow("the calling engine stopped");
    await expect(protocol.request("hello")).rejects.toThrow("not running");
    expect(written).toHaveLength(1);
  });
});
