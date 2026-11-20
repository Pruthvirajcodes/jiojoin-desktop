import { describe, expect, it } from "vitest";
import { createRedactor, redactPatterns } from "../src/shared/redact";

describe("redaction", () => {
  it("removes identities that show up inside library output", () => {
    expect(redactPatterns("sip:+915550100123@xx.wln.ims.example.test: registration success")).toBe(
      "sip:‹user›@xx.wln.ims.example.test: registration success",
    );
    expect(redactPatterns("instance 00000000-0000-1000-8000-0242AC1F0A0B")).toBe("instance ‹uuid›");
    expect(redactPatterns("mac_address=02:1a:2b:3c:4d:5e")).toBe("mac_address=‹device-id›");
    expect(redactPatterns("call from 09876543210 ended")).toBe("call from ‹number› ended");
    expect(redactPatterns("PSAPId=+915550 ok")).toBe("PSAPId=‹number› ok");
    expect(redactPatterns("peer 2405:201:abcd:1234::1 port 5068")).toBe("peer ‹ipv6› port 5068");
  });

  it("keeps what diagnostics need", () => {
    const line = "2026-11-20T10:41:02.123Z router 192.168.31.1:5068 status 503 after 16:41:02";
    expect(redactPatterns(line)).toBe(line);
  });

  it("removes registered secrets wherever they appear", () => {
    const redactor = createRedactor();
    redactor.addSecret("Synth&tic-P4ss/0123");
    redactor.addSecret("Study Mac");
    redactor.addSecret("ab");
    expect(redactor.redact('pwd="Synth&tic-P4ss/0123" on Study Mac, tab')).toBe(
      'pwd="‹redacted›" on ‹redacted›, tab',
    );
  });
});
