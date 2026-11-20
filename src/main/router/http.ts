import type { IncomingHttpHeaders } from "node:http";
import tls from "node:tls";
import { isPrivateIPv4 } from "./net";
import { PROVISIONING_PORT, ROUTER_HOSTNAME } from "./provisioning";

export interface RouterResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export class RouterHttpError extends Error {
  constructor(
    readonly code: "not-private" | "unreachable" | "timeout" | "bad-certificate" | "bad-reply",
    message: string,
  ) {
    super(message);
    this.name = "RouterHttpError";
  }
}

const MAX_BODY = 512 * 1024;

/**
 * One HTTPS request to the router's provisioning service.
 *
 * The router presents a self-signed certificate (CN jiofiber.local.html) whose
 * private key ships in every firmware image, so chain validation is impossible
 * and TLS here only gives confidentiality. The exception is scoped as tightly
 * as it can be: this function only ever dials port 8443 on a private IPv4
 * address, and nothing is sent until the peer has shown a certificate for
 * that exact name. No global TLS setting is touched.
 */
export function routerRequest(options: RouterRequestOptions): Promise<RouterResponse> {
  if (!isPrivateIPv4(options.address)) {
    return Promise.reject(new RouterHttpError("not-private", "router address is not on the local network"));
  }
  return requestOverTls(options, PROVISIONING_PORT);
}

export interface RouterRequestOptions {
  address: string;
  method: "GET" | "HEAD";
  path: string;
  cookie?: string;
  timeoutMs?: number;
}

/** The transport behind routerRequest. Exported only so tests can aim it at a local server. */
export function requestOverTls(options: RouterRequestOptions, port: number): Promise<RouterResponse> {
  const { address, method, path, cookie, timeoutMs = 15_000 } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let idle: NodeJS.Timeout | undefined;
    const finish = (outcome: { error: RouterHttpError } | { response: RouterResponse }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      socket.destroy();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.response);
    };
    const fail = (error: RouterHttpError) => finish({ error });

    const socket = tls.connect({
      host: address,
      port,
      servername: ROUTER_HOSTNAME,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    const timer = setTimeout(
      () => fail(new RouterHttpError("timeout", "the router did not answer in time")),
      timeoutMs,
    );

    socket.once("error", (error: NodeJS.ErrnoException) => {
      fail(new RouterHttpError("unreachable", error.code ?? error.message));
    });

    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const cn = Array.isArray(cert?.subject?.CN) ? cert.subject.CN[0] : cert?.subject?.CN;
      if (cn?.toLowerCase() !== ROUTER_HOSTNAME) {
        fail(new RouterHttpError("bad-certificate", "the device at this address is not a Jio router"));
        return;
      }

      const lines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${ROUTER_HOSTNAME}:${PROVISIONING_PORT}`,
        "Connection: close",
        "Accept: */*",
        ...(cookie ? [`Cookie: ${cookie}`] : []),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);

      // The gateway's HTTP is too loose for Node's parser (stray CRs in some
      // replies, bodies on HEAD, keep-alive despite Connection: close), so
      // read it by hand.
      let buffer = Buffer.alloc(0);
      const settle = (closed: boolean) => {
        const parsed = parseRawReply(buffer, method, closed);
        if (parsed === "incomplete") {
          if (closed) fail(new RouterHttpError("bad-reply", "the router's reply was cut short"));
          return;
        }
        if (parsed === "invalid") {
          fail(new RouterHttpError("bad-reply", "the router's reply was not HTTP"));
          return;
        }
        finish({ response: parsed });
      };
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_BODY) {
          fail(new RouterHttpError("bad-reply", "the router's reply was too large"));
          return;
        }
        settle(false);
        // A reply with no length ends when the gateway goes quiet.
        clearTimeout(idle);
        if (!settled) idle = setTimeout(() => settle(true), 1500);
      });
      socket.once("end", () => settle(true));
    });
  });
}

/**
 * Reads one HTTP/1.x reply from raw bytes. A line ends at LF; any CRs before
 * it are dropped, so "\r\r\n" and bare "\n" both work. Returns "incomplete" until the headers and the declared body have
 * arrived; with no Content-Length the body runs until the connection closes.
 */
export function parseRawReply(
  raw: Buffer,
  method: "GET" | "HEAD",
  closed: boolean,
): RouterResponse | "incomplete" | "invalid" {
  const text = raw.toString("latin1");
  const end = /\n[\r \t]*\n/.exec(text);
  if (!end) return closed && text.length > 0 ? "invalid" : "incomplete";

  const [statusLine = "", ...headerLines] = text.slice(0, end.index).split("\n");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine.trim());
  if (!status) return "invalid";

  const headers: IncomingHttpHeaders = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "set-cookie") headers["set-cookie"] = [...(headers["set-cookie"] ?? []), value];
    else headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }

  const bodyStart = end.index + end[0].length; // latin1: one byte per char
  const response = (body: Buffer): RouterResponse => ({
    status: Number(status[1]),
    headers,
    body: body.toString("utf8"),
  });
  // The gateway sends a body even for HEAD; a probe only needs the headers.
  if (method === "HEAD") return response(Buffer.alloc(0));

  const declared = Number.parseInt(String(headers["content-length"] ?? ""), 10);
  if (Number.isFinite(declared) && declared >= 0) {
    if (raw.length - bodyStart < declared) return "incomplete";
    return response(raw.subarray(bodyStart, bodyStart + declared));
  }
  return closed ? response(raw.subarray(bodyStart)) : "incomplete";
}
