import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineProcess } from "../src/main/engine/process";
import type { EngineEvent } from "../src/main/engine/protocol";
import { buildDialUri, buildSipAccount } from "../src/main/router/provisioning";

/**
 * Runs the real engine against a SIP-over-TLS gateway on loopback and checks
 * the messages it puts on the wire: the parts of the Jio profile that cannot
 * be exercised against a live line without the owner's OTP. Every identity
 * and secret here is synthetic, and nothing leaves this machine.
 */

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

function selfSigned(commonName: string): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "jiojoin-test-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${commonName}`,
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface SipMessage {
  start: string;
  headers: Map<string, string[]>;
  body: string;
}

const header = (message: SipMessage, name: string) => message.headers.get(name.toLowerCase())?.[0] ?? "";
const headers = (message: SipMessage, name: string) => message.headers.get(name.toLowerCase()) ?? [];

function parseSip(text: string): SipMessage {
  const split = text.indexOf("\r\n\r\n");
  const [start = "", ...lines] = text.slice(0, split).split("\r\n");
  const map = new Map<string, string[]>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    map.set(name, [...(map.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  return { start, headers: map, body: text.slice(split + 4) };
}

const md5 = (value: string) => createHash("md5").update(value).digest("hex");

/** A just-enough SIP gateway: frames messages off the TLS stream and lets the test answer them. */
class FakeGateway {
  readonly received: SipMessage[] = [];
  port = 0;
  private server: tls.Server;
  private socket: tls.TLSSocket | null = null;
  private waiters: { test(message: SipMessage): boolean; resolve(message: SipMessage): void }[] = [];
  onRequest: (message: SipMessage) => void = () => {};

  constructor(identity: { key: string; cert: string }) {
    this.server = tls.createServer(identity, (socket) => {
      this.socket = socket;
      let buffer = "";
      socket.setEncoding("latin1");
      socket.on("error", () => {});
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          buffer = buffer.replace(/^(\r\n)+/, "");
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const length = Number(/\r\n(?:content-length|l)\s*:\s*(\d+)/i.exec(buffer.slice(0, end + 2))?.[1] ?? 0);
          if (buffer.length < end + 4 + length) return;
          const message = parseSip(buffer.slice(0, end + 4 + length));
          buffer = buffer.slice(end + 4 + length);
          this.received.push(message);
          this.waiters = this.waiters.filter((waiter) => {
            if (!waiter.test(message)) return true;
            waiter.resolve(message);
            return false;
          });
          if (!message.start.startsWith("SIP/2.0")) this.onRequest(message);
        }
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  next(test: (message: SipMessage) => boolean): Promise<SipMessage> {
    const seen = this.received.find(test);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }

  send(lines: string[], body = ""): void {
    this.socket?.write([...lines, `Content-Length: ${Buffer.byteLength(body)}`, "", body].join("\r\n"), "latin1");
  }

  respond(request: SipMessage, status: string, extra: string[] = []): void {
    const to = header(request, "to");
    this.send([
      `SIP/2.0 ${status}`,
      ...headers(request, "via").map((via) => `Via: ${via}`),
      `From: ${header(request, "from")}`,
      `To: ${to.includes("tag=") ? to : `${to};tag=gw${request.start.length}`}`,
      `Call-ID: ${header(request, "call-id")}`,
      `CSeq: ${header(request, "cseq")}`,
      ...extra,
    ]);
  }

  close(): Promise<void> {
    this.socket?.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const LINE = {
  realm: "xx.wln.ims.example.test",
  homeDomain: "xx.wln.ims.example.test",
  authUser: "915550100123@xx.wln.ims.example.test",
  password: "Synth&tic-P4ss/0123",
  publicIdentity: "sip:+915550100123@xx.wln.ims.example.test",
  instanceId: "00000000-0000-1000-8000-0242AC1F0A0B",
  psoltid: "+915550",
  sipPort: 0,
};
const PANI = "GPON;PSAPId=+915550";
const INSTANCE = '+sip.instance="<00000000-0000-1000-8000-0242AC1F0A0B>"';

const routerIdentity = selfSigned("jiofiber.local.html");
const otherIdentity = selfSigned("router.example");
const runnable = existsSync(binary) && routerIdentity !== null && otherIdentity !== null;

describe.skipIf(!runnable)("engine on the wire", () => {
  let gateway: FakeGateway;
  let engine: EngineProcess;
  const events: EngineEvent[] = [];
  const eventWaiters: { test(event: EngineEvent): boolean; resolve(event: EngineEvent): void }[] = [];

  const nextEvent = <T extends EngineEvent>(test: (event: EngineEvent) => event is T): Promise<T> => {
    const seen = events.find(test);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => eventWaiters.push({ test, resolve: resolve as (event: EngineEvent) => void }));
  };

  const account = (port: number) =>
    buildSipAccount({ ...LINE, sipPort: port }, "127.0.0.1", "127.0.0.1") as Record<string, unknown>;

  /** Answers REGISTER the way the router does: challenge once, then accept a correct digest. */
  const registrar = (target: FakeGateway) => (request: SipMessage) => {
    if (!request.start.startsWith("REGISTER")) return;
    const authorization = header(request, "authorization");
    const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(authorization)?.[1] ?? "";
    const expected = md5(
      `${md5(`${LINE.authUser}:${LINE.realm}:${LINE.password}`)}:nonce-1:${md5(`REGISTER:${field("uri")}`)}`,
    );
    if (field("response") !== expected) {
      target.respond(request, "401 Unauthorized", [
        `WWW-Authenticate: Digest nonce="nonce-1",algorithm=MD5,realm="${LINE.realm}"`,
      ]);
      return;
    }
    const expires = /expires=0|^0$/.test(header(request, "expires")) ? 0 : 3600;
    target.respond(request, "200 OK", [
      "Require: outbound",
      `Contact: ${header(request, "contact")};expires=${expires}`,
    ]);
  };

  beforeAll(async () => {
    process.env.JIOJOIN_ENGINE_NULL_AUDIO = "1";
    gateway = new FakeGateway(routerIdentity!);
    await gateway.listen();
    gateway.onRequest = registrar(gateway);

    engine = new EngineProcess(binary);
    engine.onEvent = (event) => {
      events.push(event);
      for (const waiter of [...eventWaiters]) {
        if (!waiter.test(event)) continue;
        eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    };
    await engine.start();
  });

  afterAll(async () => {
    await engine.stop();
    await gateway.close();
  });

  it("registers the way the router's voice gateway expects", async () => {
    await engine.request("register", account(gateway.port));
    const registered = await nextEvent(
      (event): event is Extract<EngineEvent, { event: "reg" }> => event.event === "reg" && event.state === "registered",
    );
    expect(registered).toMatchObject({ code: 200, expires: 3600 });

    const registers = gateway.received.filter((message) => message.start.startsWith("REGISTER"));
    expect(registers).toHaveLength(2);
    for (const register of registers) {
      expect(register.start).toBe("REGISTER sip:xx.wln.ims.example.test SIP/2.0");
      expect(header(register, "via")).toMatch(/^SIP\/2\.0\/TLS 127\.0\.0\.1:\d+/);
      expect(header(register, "from")).toContain("<sip:+915550100123@xx.wln.ims.example.test>");
      expect(header(register, "to")).toBe("<sip:+915550100123@xx.wln.ims.example.test>");
      // Present on every request, including the unauthenticated first one.
      expect(headers(register, "p-access-network-info")).toEqual([PANI]);
      expect(header(register, "user-agent")).toMatch(/^JioJoinDesktop\/\S+ JUICEJSE\/\S+$/);
      expect(header(register, "expires")).toBe("3600");
      expect(header(register, "supported")).toMatch(/outbound/);
      expect(header(register, "supported")).toMatch(/path/);

      const contact = header(register, "contact");
      expect(contact).toMatch(/^<sip:\+915550100123@127\.0\.0\.1:\d+;transport=TLS;ob>/i);
      // Jio's bare-UUID instance id (no "urn:uuid:"), exactly once.
      expect(contact.split("+sip.instance=")).toHaveLength(2);
      expect(contact).toContain(INSTANCE);
      expect(contact).toContain(";reg-id=1");
      expect(contact).toContain('+g.3gpp.icsi-ref="urn%3Aurn-7%3A3gpp-service.ims.icsi.mmtel"');
      expect(contact).toContain('+g.3gpp.iari-ref="urn%3Aurn-7%3A3gpp-application.ims.iari.rcs.jio.eucr"');
    }
    expect(header(registers[0]!, "authorization")).toBe("");
    const authorization = header(registers[1]!, "authorization");
    expect(authorization).toContain(`username="${LINE.authUser}"`);
    expect(authorization).toContain(`realm="${LINE.realm}"`);
    expect(authorization).toContain('uri="sip:xx.wln.ims.example.test"');
  });

  it("places a call with the IMS headers and an AMR-WB-first offer, and reports a busy line", async () => {
    gateway.onRequest = (request) => {
      if (request.start.startsWith("INVITE")) {
        gateway.respond(request, "100 Trying");
        gateway.respond(request, "486 Busy Here");
      } else registrar(gateway)(request);
    };
    await engine.request("dial", { uri: buildDialUri("09876543210", LINE.homeDomain), number: "09876543210" });

    const ended = await nextEvent(
      (event): event is Extract<EngineEvent, { event: "call" }> => event.event === "call" && event.state === "ended",
    );
    expect(ended).toMatchObject({ direction: "out", code: 486, number: "09876543210" });

    const invite = await gateway.next((message) => message.start.startsWith("INVITE"));
    // PJSIP prints user= before other URI parameters; the order carries no meaning.
    expect(invite.start).toBe(
      "INVITE sip:09876543210@xx.wln.ims.example.test;user=phone;phone-context=xx.wln.ims.example.test SIP/2.0",
    );
    expect(headers(invite, "p-access-network-info")).toEqual([PANI]);
    expect(header(invite, "p-preferred-identity")).toBe("<sip:+915550100123@xx.wln.ims.example.test>");
    expect(header(invite, "contact")).toContain(INSTANCE);
    expect(header(invite, "contact")).toContain("+g.3gpp.icsi-ref=");
    expect(header(invite, "supported")).toMatch(/100rel/);
    expect(header(invite, "supported")).toMatch(/timer/);

    const sdp = invite.body;
    expect(sdp).toMatch(/^c=IN IP4 127\.0\.0\.1\r$/m);
    const media = /^m=audio (\d+) RTP\/AVP ([\d ]+)\r$/m.exec(sdp);
    const port = Number(media?.[1]);
    expect(port).toBeGreaterThanOrEqual(52000);
    expect(port).toBeLessThan(52200);
    // Codec order: AMR-WB, AMR-NB, PCMU, then DTMF events.
    const codecs = (media?.[2] ?? "").split(" ").map((pt) => new RegExp(`a=rtpmap:${pt} ([^\\r]+)`).exec(sdp)?.[1] ?? `static-${pt}`);
    expect(codecs.slice(0, 3)).toEqual(["AMR-WB/16000", "AMR/8000", "PCMU/8000"]);
    expect(codecs).toContain("telephone-event/8000");
    const fmtp = (codec: string) => {
      const pt = new RegExp(`a=rtpmap:(\\d+) ${codec.replace("/", "\\/")}`).exec(sdp)?.[1];
      return new RegExp(`a=fmtp:${pt} ([^\\r]+)`).exec(sdp)?.[1] ?? "";
    };
    expect(fmtp("AMR-WB/16000")).toBe("octet-align=1;mode-set=0,1,2,3,4,5,6,7,8");
    expect(fmtp("AMR/8000")).toBe("octet-align=1;mode-set=0,1,2,3,4,5,6,7");
    expect(sdp).not.toMatch(/crypto|RTP\/SAVP/);

    // The ACK for the 486 carries the access-network header too.
    const ack = await gateway.next((message) => message.start.startsWith("ACK"));
    expect(headers(ack, "p-access-network-info")).toEqual([PANI]);
  });

  it("rings for an incoming call, names the caller from P-Asserted-Identity, and can decline", async () => {
    const contact = /<([^>]+)>/.exec(
      header(gateway.received.find((message) => message.start.startsWith("REGISTER"))!, "contact"),
    )?.[1];
    const offer = [
      "v=0",
      "o=gw 1 1 IN IP4 127.0.0.1",
      "s=-",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      "m=audio 40000 RTP/AVP 104 110",
      "a=rtpmap:104 AMR-WB/16000",
      "a=fmtp:104 octet-align=1;mode-set=0,1,2",
      "a=rtpmap:110 telephone-event/16000",
      "a=sendrecv",
      "",
    ].join("\r\n");
    gateway.send(
      [
        `INVITE ${contact} SIP/2.0`,
        `Via: SIP/2.0/TLS 127.0.0.1:${gateway.port};branch=z9hG4bK-incoming-1`,
        "Max-Forwards: 70",
        'From: "Anonymous" <sip:anonymous@anonymous.invalid>;tag=gw-in',
        "To: <sip:+915550100123@xx.wln.ims.example.test>",
        "Call-ID: incoming-call-1",
        "CSeq: 1 INVITE",
        `Contact: <sip:127.0.0.1:${gateway.port};transport=tls>`,
        'P-Asserted-Identity: "Asha" <sip:+919812345678@xx.wln.ims.example.test>',
        "Content-Type: application/sdp",
      ],
      offer,
    );

    const incoming = await nextEvent(
      (event): event is Extract<EngineEvent, { event: "call" }> => event.event === "call" && event.direction === "in",
    );
    expect(incoming).toMatchObject({ state: "incoming", number: "+919812345678", name: "Asha" });
    const ringing = await gateway.next((message) => message.start.startsWith("SIP/2.0 180"));
    expect(header(ringing, "call-id")).toBe("incoming-call-1");

    await engine.request("hangup");
    const declined = await gateway.next(
      (message) => /^SIP\/2\.0 [46]\d\d/.test(message.start) && header(message, "call-id") === "incoming-call-1",
    );
    expect(declined.start).toBe("SIP/2.0 603 Decline");
    gateway.send([
      `ACK ${contact} SIP/2.0`,
      `Via: SIP/2.0/TLS 127.0.0.1:${gateway.port};branch=z9hG4bK-incoming-1`,
      "Max-Forwards: 70",
      "From: <sip:anonymous@anonymous.invalid>;tag=gw-in",
      `To: ${header(declined, "to")}`,
      "Call-ID: incoming-call-1",
      "CSeq: 1 ACK",
    ]);
    const ended = await nextEvent(
      (event): event is Extract<EngineEvent, { event: "call" }> =>
        event.event === "call" && event.direction === "in" && event.state === "ended",
    );
    expect(ended.number).toBe("+919812345678");
  });

  it("sends nothing to a TLS server whose certificate does not name the router", async () => {
    const impostor = new FakeGateway(otherIdentity!);
    await impostor.listen();
    try {
      events.length = 0;
      await engine.request("register", account(impostor.port));
      const rejected = await nextEvent(
        (event): event is Extract<EngineEvent, { event: "transport" }> =>
          event.event === "transport" && event.state === "rejected",
      );
      expect(rejected.reason).toBe("certificate-name-mismatch");
      await nextEvent(
        (event): event is Extract<EngineEvent, { event: "reg" }> => event.event === "reg" && event.state === "failed",
      );
      expect(impostor.received).toEqual([]);
    } finally {
      await impostor.close();
    }
  });
});
