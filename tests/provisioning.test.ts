import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDialUri,
  buildOtpPath,
  buildProvisioningPath,
  buildSipAccount,
  cookieFromSetCookie,
  numberFromIdentity,
  parseProvisioningReply,
  parseProvisioningXml,
  sanitizeDeviceName,
} from "../src/main/router/provisioning";

const fixture = readFileSync(new URL("./fixtures/provisioning.xml", import.meta.url), "utf8");
const identity = { deviceId: "02:1a:2b:3c:4d:5e", deviceName: "Study Mac" };

describe("provisioning request", () => {
  it("builds the RCS auto-configuration query", () => {
    const path = buildProvisioningPath(identity, "add");
    const query = new URL(`https://router${path}`).searchParams;
    expect(path.startsWith("/?")).toBe(true);
    expect(query.get("client_vendor")).toBe("JUIC");
    expect(query.get("rcs_profile")).toBe("joyn_blackbird");
    expect(query.get("nwk_intf")).toBe("wifi");
    expect(query.get("op_type")).toBe("add");
    expect(query.get("mac_address")).toBe("02:1a:2b:3c:4d:5e");
    expect(query.get("alias")).toBe("Study-Mac");
    expect(query.get("terminal_model")).toBe("Study-Mac");
  });

  it("leaves op_type out of a plain refresh so it can never trigger an OTP text", () => {
    const query = new URL(`https://router${buildProvisioningPath(identity)}`).searchParams;
    expect(query.has("op_type")).toBe(false);
    expect(query.get("mac_address")).toBe(identity.deviceId);
  });

  it("keeps device names to characters the router's parser accepts", () => {
    expect(sanitizeDeviceName("  Priya's MacBook Pro (work) ")).toBe("Priyas-MacBook-Pro-work");
    expect(sanitizeDeviceName("&op_type=add")).toBe("op_typeadd");
    expect(sanitizeDeviceName("डेस्क")).toBe("Desktop");
    expect(sanitizeDeviceName("x".repeat(80))).toHaveLength(32);
  });

  it("only accepts numeric OTPs", () => {
    expect(buildOtpPath("482913")).toBe("/?OTP=482913");
    expect(() => buildOtpPath("48 29")).toThrow();
    expect(() => buildOtpPath("1&op_type=remove")).toThrow();
  });
});

describe("provisioning reply", () => {
  it("reads the SIP account from the XML", () => {
    const parsed = parseProvisioningXml(fixture);
    expect(parsed).toEqual({
      ok: true,
      line: {
        realm: "xx.wln.ims.example.test",
        homeDomain: "xx.wln.ims.example.test",
        authUser: "915550100123@xx.wln.ims.example.test",
        password: "Synth&tic-P4ss/0123",
        publicIdentity: "sip:+915550100123@xx.wln.ims.example.test",
        instanceId: "00000000-0000-1000-8000-0242AC1F0A0B",
        psoltid: "+915550",
        sipPort: 5068,
      },
    });
  });

  it("falls back to the private identity when there is no username", () => {
    const parsed = parseProvisioningXml(fixture.replace(/<parm name="username"[^>]*>/, ""));
    expect(parsed.ok && parsed.line.authUser).toBe("915550100123@xx.wln.ims.example.test");
  });

  it("rejects a document without a password or identity", () => {
    const parsed = parseProvisioningXml(fixture.replace(/<parm name="userpwd"[^>]*>/, ""));
    expect(parsed).toMatchObject({ ok: false, reason: "reply is missing password", noAccount: false });
    expect(parseProvisioningXml("<html>501</html>").ok).toBe(false);
    expect(parseProvisioningXml("<wap-provisioningdoc").ok).toBe(false);
  });

  it("classifies a config reply", () => {
    const reply = parseProvisioningReply({ status: 200, headers: {}, body: fixture });
    expect(reply.kind).toBe("config");
  });

  it("classifies an OTP challenge and keeps the session cookie", () => {
    const reply = parseProvisioningReply({
      status: 200,
      headers: {
        "set-cookie": ["WITRCSeConfigCookie=11111111-2222-3333-4444-555555555555; Path=/; Secure"],
        "x-amn": "+91********12",
      },
      body: "",
    });
    expect(reply).toEqual({
      kind: "otp-required",
      cookie: "WITRCSeConfigCookie=11111111-2222-3333-4444-555555555555",
      sentTo: "+91********12",
    });
  });

  it("reads a provisioning document with no account as 'not on the whitelist'", () => {
    // JUICE answers an unknown device's plain request with HTTP 200 and a
    // provisioning document that carries no SIP credentials.
    const unauthorised =
      '<?xml version="1.0"?><wap-provisioningdoc version="1.1"><characteristic type="VERS">' +
      '<parm name="version" value="-2"/><parm name="validity" value="-2"/></characteristic></wap-provisioningdoc>';
    expect(parseProvisioningReply({ status: 200, headers: {}, body: unauthorised })).toEqual({ kind: "not-authorised" });
    // A partial account is a broken reply, not a verdict on the device.
    const partial = fixture.replace(/<parm name="userpwd"[^>]*>/, "");
    expect(parseProvisioningReply({ status: 200, headers: {}, body: partial }).kind).toBe("rejected");
    // An error page is never read as "not authorised".
    expect(parseProvisioningReply({ status: 503, headers: {}, body: unauthorised }).kind).toBe("rejected");
  });

  it("classifies anything else as a rejection", () => {
    expect(parseProvisioningReply({ status: 403, headers: {}, body: "" })).toEqual({
      kind: "rejected",
      status: 403,
      reason: "HTTP 403",
    });
    expect(parseProvisioningReply({ status: 200, headers: {}, body: "" }).kind).toBe("rejected");
    expect(parseProvisioningReply({ status: 200, headers: {}, body: "Not Implemented" }).kind).toBe(
      "rejected",
    );
  });

  it("joins several cookies", () => {
    expect(cookieFromSetCookie(["a=1; Path=/", "b=2; HttpOnly"])).toBe("a=1; b=2");
    expect(cookieFromSetCookie(undefined)).toBe("");
  });
});

describe("SIP account", () => {
  const parsed = parseProvisioningXml(fixture);
  if (!parsed.ok) throw new Error("fixture must parse");

  it("derives the engine's register parameters", () => {
    expect(buildSipAccount(parsed.line, "192.168.29.1", "192.168.29.40")).toEqual({
      proxy: "sip:192.168.29.1:5068;transport=tls;lr",
      registrar: "sip:xx.wln.ims.example.test",
      identity: "sip:+915550100123@xx.wln.ims.example.test",
      authUser: "915550100123@xx.wln.ims.example.test",
      authRealm: "xx.wln.ims.example.test",
      password: "Synth&tic-P4ss/0123",
      instanceId: "00000000-0000-1000-8000-0242AC1F0A0B",
      pani: "GPON;PSAPId=+915550",
      localAddress: "192.168.29.40",
      tlsName: "jiofiber.local.html",
      rtpPort: 52000,
      expires: 3600,
    });
  });

  it("extracts the subscriber number and builds dial URIs", () => {
    expect(numberFromIdentity(parsed.line.publicIdentity)).toBe("+915550100123");
    expect(buildDialUri("09876543210", "xx.example.test")).toBe(
      "sip:09876543210@xx.example.test;phone-context=xx.example.test;user=phone",
    );
    expect(buildDialUri("*121#", "xx.example.test")).toBe(
      "sip:*121%23@xx.example.test;phone-context=xx.example.test;user=phone",
    );
  });
});
