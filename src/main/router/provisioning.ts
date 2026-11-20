import { XMLParser } from "fast-xml-parser";

/**
 * The router's provisioning service (JUICE, HTTPS port 8443) speaks a GSMA
 * RCS auto-configuration dialect. This module only builds requests and reads
 * replies; the network call lives in ./http.ts.
 */

export const ROUTER_HOSTNAME = "jiofiber.local.html";
export const PROVISIONING_PORT = 8443;
export const DEFAULT_SIP_PORT = 5068;

export interface ProvisioningIdentity {
  /** Stable per-install identifier in MAC-address form; the router whitelists it. */
  deviceId: string;
  deviceName: string;
}

export interface ProvisionedLine {
  realm: string;
  homeDomain: string;
  authUser: string;
  password: string;
  /** For example "sip:+91XXXXXXXXXX@realm". */
  publicIdentity: string;
  instanceId: string;
  psoltid: string;
  sipPort: number;
}

export type ProvisioningReply =
  | { kind: "config"; line: ProvisionedLine }
  | { kind: "otp-required"; cookie: string; sentTo: string }
  /**
   * The router answered normally but handed over no account: this device is
   * not on its whitelist (never added, removed in JioHome, or pushed out by a
   * newer device). JUICE 1.5.5 logs "Device Not Found in Whitelist" and sends
   * a provisioning document with no SIP credentials.
   */
  | { kind: "not-authorised" }
  | { kind: "rejected"; status: number; reason: string };

/** Only characters that are safe in the router's query parser. */
export function sanitizeDeviceName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 32);
  return cleaned === "" ? "Desktop" : cleaned;
}

/**
 * `opType: "add"` asks the router to whitelist this device, which makes it
 * text a one-time code to the line's registered mobile when the device is
 * new. Without it the router only answers devices it already knows.
 */
export function buildProvisioningPath(identity: ProvisioningIdentity, opType?: "add"): string {
  const name = sanitizeDeviceName(identity.deviceName);
  const query = new URLSearchParams({
    terminal_sw_version: "RCSAndrd",
    terminal_vendor: name,
    terminal_model: name,
    SMS_port: "0",
    act_type: "volatile",
    IMSI: "",
    msisdn: "",
    IMEI: "",
    vers: "0",
    token: "",
    rcs_state: "0",
    rcs_version: "5.1B",
    rcs_profile: "joyn_blackbird",
    client_vendor: "JUIC",
    default_sms_app: "2",
    default_vvm_app: "0",
    device_type: "vvm",
    client_version: "JSEAndrd-1.0",
    mac_address: identity.deviceId,
    alias: name,
    nwk_intf: "wifi",
  });
  if (opType) query.set("op_type", opType);
  return `/?${query.toString()}`;
}

export function isValidOtp(code: string): boolean {
  return /^\d{4,8}$/.test(code);
}

export function buildOtpPath(code: string): string {
  if (!isValidOtp(code)) throw new Error("OTP must be 4 to 8 digits");
  return `/?OTP=${code}`;
}

/** Reduces `Set-Cookie` headers to the `name=value` pairs a `Cookie` header needs. */
export function cookieFromSetCookie(header: string | string[] | undefined): string {
  if (!header) return "";
  const list = Array.isArray(header) ? header : [header];
  return list
    .map((entry) => entry.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("="))
    .join("; ");
}

interface RawReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function parseProvisioningReply(reply: RawReply): ProvisioningReply {
  const body = reply.body.trim();
  if (reply.status === 200 && body.includes("<wap-provisioningdoc")) {
    const parsed = parseProvisioningXml(body);
    if (parsed.ok) return { kind: "config", line: parsed.line };
    // A well-formed document with no account at all is the router's "not on
    // the whitelist" answer. A partial account is a reply we can't use.
    if (parsed.reason === "unreadable reply" || !parsed.noAccount) {
      return { kind: "rejected", status: reply.status, reason: parsed.reason };
    }
    return { kind: "not-authorised" };
  }
  const cookie = cookieFromSetCookie(reply.headers["set-cookie"]);
  if (reply.status === 200 && body === "" && cookie !== "") {
    const sentTo = reply.headers["x-amn"];
    return {
      kind: "otp-required",
      cookie,
      sentTo: typeof sentTo === "string" ? sentTo.trim() : "",
    };
  }
  return {
    kind: "rejected",
    status: reply.status,
    reason: reply.status === 200 ? "empty reply" : `HTTP ${reply.status}`,
  };
}

interface Parm {
  name: string;
  value: string;
  /** Types of the enclosing <characteristic> elements, outermost first. */
  path: string[];
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "characteristic" || name === "parm",
  // Values are identifiers and secrets: never coerce "0123" or "1e5" to numbers.
  parseAttributeValue: false,
  processEntities: true,
});

function collectParms(node: unknown, path: string[], out: Parm[]): void {
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  for (const parm of (record.parm as unknown[] | undefined) ?? []) {
    if (typeof parm !== "object" || parm === null) continue;
    const { name, value } = parm as Record<string, unknown>;
    if (typeof name === "string") out.push({ name, value: String(value ?? ""), path });
  }
  for (const child of (record.characteristic as unknown[] | undefined) ?? []) {
    if (typeof child !== "object" || child === null) continue;
    const type = (child as Record<string, unknown>).type;
    collectParms(child, [...path, typeof type === "string" ? type : ""], out);
  }
}

export function parseProvisioningXml(
  text: string,
): { ok: true; line: ProvisionedLine } | { ok: false; reason: string; noAccount?: boolean } {
  let doc: unknown;
  try {
    doc = (xml.parse(text) as Record<string, unknown>)["wap-provisioningdoc"];
  } catch {
    return { ok: false, reason: "unreadable reply" };
  }
  if (!doc) return { ok: false, reason: "unreadable reply" };

  const parms: Parm[] = [];
  collectParms(doc, [], parms);
  const first = (name: string, under?: string): string =>
    parms
      .find((p) => p.name.toLowerCase() === name && (!under || p.path.includes(under)))
      ?.value.trim() ?? "";

  const realm = first("realm", "appauth") || first("realm");
  const homeDomain = first("home_network_domain_name") || realm;
  const password = first("userpwd", "appauth") || first("userpwd");
  const publicIdentity = first("public_user_identity");
  const privateIdentity = first("private_user_identity");
  const authUser =
    first("username", "appauth") || first("username") || privateIdentity.replace(/^sips?:/i, "");
  const instanceId = first("uuid_value");
  const psoltid = first("psoltid");
  const address = first("address", "lbo_p-cscf_address");

  const missing = Object.entries({ realm, password, publicIdentity, authUser, instanceId })
    .filter(([, value]) => value === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `reply is missing ${missing.join(", ")}`,
      noAccount: password === "" && publicIdentity === "",
    };
  }
  if (!/^sips?:[^@\s]+@[^@\s]+$/i.test(publicIdentity)) {
    return { ok: false, reason: "reply has an unusable identity" };
  }
  if (!/^[0-9a-f-]{8,64}$/i.test(instanceId)) {
    return { ok: false, reason: "reply has an unusable instance id" };
  }

  return {
    ok: true,
    line: {
      realm,
      homeDomain,
      authUser,
      password,
      publicIdentity,
      instanceId,
      psoltid,
      sipPort: portFromAddress(address),
    },
  };
}

function portFromAddress(address: string): number {
  const match = /:(\d{2,5})$/.exec(address);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SIP_PORT;
}

/** The subscriber number inside a public identity, for example "+912212345678". */
export function numberFromIdentity(publicIdentity: string): string {
  return /^sips?:([^@]+)@/i.exec(publicIdentity)?.[1] ?? "";
}

/** What the engine's `register` command needs, derived from one provisioning reply. */
export function buildSipAccount(line: ProvisionedLine, routerAddress: string, localAddress: string) {
  const psap = line.psoltid.replace(/^\+/, "");
  return {
    proxy: `sip:${routerAddress}:${line.sipPort};transport=tls;lr`,
    registrar: `sip:${line.homeDomain}`,
    identity: line.publicIdentity,
    authUser: line.authUser,
    authRealm: line.realm,
    password: line.password,
    instanceId: line.instanceId,
    pani: psap ? `GPON;PSAPId=+${psap}` : "GPON",
    localAddress,
    tlsName: ROUTER_HOSTNAME,
    rtpPort: 52000,
    expires: 3600,
  };
}

/**
 * Request-URI for a dial string, in the form Jio's own client sends: a
 * national number with the home domain as its phone-context.
 * "#" is not legal in a SIP user part unescaped.
 */
export function buildDialUri(dial: string, homeDomain: string): string {
  return `sip:${dial.replace(/#/g, "%23")}@${homeDomain};phone-context=${homeDomain};user=phone`;
}
