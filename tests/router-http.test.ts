import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterHttpError, requestOverTls, routerRequest } from "../src/main/router/http";
import { parseProvisioningReply } from "../src/main/router/provisioning";

/**
 * A stand-in for the router's embedded HTTPS server, written at the socket
 * level so it can reproduce that server's departures from the HTTP spec.
 */
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

const routerIdentity = selfSigned("jiofiber.local.html");
const otherIdentity = selfSigned("router.example");
const xml = readFileSync(new URL("./fixtures/provisioning.xml", import.meta.url), "utf8");

interface FakeRouter {
  port: number;
  received: string[];
  close(): Promise<void>;
}

function fakeRouter(identity: { key: string; cert: string }, respond: (request: string) => string | null) {
  return new Promise<FakeRouter>((resolve) => {
    const received: string[] = [];
    const sockets = new Set<tls.TLSSocket>();
    const server = tls.createServer(identity, (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (data) => {
        const request = data.toString("latin1");
        received.push(request);
        const reply = respond(request);
        // Like the real gateway, leave the connection open afterwards.
        if (reply !== null) socket.write(reply);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        received,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const reply = (status: string, headers: string[], body = "") =>
  [`HTTP/1.1 ${status}`, ...headers, "", body].join("\r\n");

describe.skipIf(!routerIdentity || !otherIdentity)("router HTTPS transport", () => {
  let router: FakeRouter;
  let impostor: FakeRouter;

  beforeAll(async () => {
    router = await fakeRouter(routerIdentity!, (request) => {
      if (request.startsWith("HEAD ")) {
        // A body on a HEAD reply is invalid HTTP, and exactly what JUICE 1.5.5 sends.
        return reply(
          "501 Not Implemented",
          ["Content-Length: 15", "Content-Type: text/html", "Connection: Keep-Alive", "Server: JIDU6911/JUICEJFV-1.5.5"],
          "Not Implemented",
        );
      }
      if (request.includes("op_type=add")) {
        // The stray CR before CRLF is what made Node's parser fail with HPE_LF_EXPECTED.
        return reply("200 OK", [
          "Content-Length: 0",
          "Set-Cookie: WITRCSeConfigCookie=11111111-2222-3333-4444-555555555555",
          "x-amn: +91********12\r",
          "Connection: Keep-Alive",
        ]);
      }
      if (request.includes("silent=1")) return null;
      return reply(
        "200 OK",
        [`Content-Length: ${Buffer.byteLength(xml)}`, "Content-Type: text/xml", "Connection: Keep-Alive"],
        xml,
      );
    });
    impostor = await fakeRouter(otherIdentity!, () => reply("200 OK", ["Content-Length: 0"]));
  });

  afterAll(async () => {
    await router.close();
    await impostor.close();
  });

  const request = (path: string, method: "GET" | "HEAD" = "GET", extra: { cookie?: string; timeoutMs?: number } = {}) =>
    requestOverTls({ address: "127.0.0.1", method, path, ...extra }, router.port);

  it("accepts the gateway's HEAD reply even though it carries a body", async () => {
    const response = await request("/", "HEAD");
    expect(response.status).toBe(501);
    expect(response.headers.server).toBe("JIDU6911/JUICEJFV-1.5.5");
  });

  it("reads a config reply without waiting for the connection to close", async () => {
    const response = await request("/?mac_address=02:00:00:00:00:01");
    expect(parseProvisioningReply(response)).toMatchObject({
      kind: "config",
      line: { realm: "xx.wln.ims.example.test", sipPort: 5068 },
    });
  });

  it("reads an OTP challenge: empty body, session cookie, masked number", async () => {
    const response = await request("/?mac_address=02:00:00:00:00:01&op_type=add");
    expect(parseProvisioningReply(response)).toEqual({
      kind: "otp-required",
      cookie: "WITRCSeConfigCookie=11111111-2222-3333-4444-555555555555",
      sentTo: "+91********12",
    });
  });

  it("pins the request to the router's host name and sends the session cookie", async () => {
    await request("/?OTP=482913", "GET", { cookie: "WITRCSeConfigCookie=abc" });
    const sent = router.received.at(-1) ?? "";
    expect(sent).toMatch(/^GET \/\?OTP=482913 HTTP\/1\.1\r\n/);
    expect(sent).toMatch(/\r\nHost: jiofiber\.local\.html:8443\r\n/);
    expect(sent).toMatch(/\r\nCookie: WITRCSeConfigCookie=abc\r\n/);
  });

  it("sends nothing to a server whose certificate does not name the router", async () => {
    const attempt = requestOverTls({ address: "127.0.0.1", method: "GET", path: "/?secret=1" }, impostor.port);
    await expect(attempt).rejects.toMatchObject({ code: "bad-certificate" });
    expect(impostor.received).toEqual([]);
  });

  it("gives up on a router that never answers", async () => {
    await expect(request("/?silent=1", "GET", { timeoutMs: 150 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses to contact anything outside the local network", async () => {
    for (const address of ["8.8.8.8", "127.0.0.1", "jiofiber.local.html"]) {
      const attempt = routerRequest({ address, method: "HEAD", path: "/" });
      await expect(attempt).rejects.toBeInstanceOf(RouterHttpError);
      await expect(attempt).rejects.toMatchObject({ code: "not-private" });
    }
  });

  it("reports an unreachable router", async () => {
    const closed = await fakeRouter(routerIdentity!, () => null);
    await closed.close();
    await expect(
      requestOverTls({ address: "127.0.0.1", method: "HEAD", path: "/" }, closed.port),
    ).rejects.toMatchObject({ code: "unreachable" });
  });
});
