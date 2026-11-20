import { describe, expect, it } from "vitest";
import { canonicalNumber, formatAsTyped, formatNumber, sanitizeDialInput, toDialString } from "../src/shared/phone";

const dial = (input: string) => {
  const result = toDialString(input);
  return result.ok ? result.dial : `error: ${result.reason}`;
};

describe("dial string", () => {
  it.each([
    ["9876543210", "09876543210"],
    ["98765 43210", "09876543210"],
    ["+91 98765-43210", "09876543210"],
    ["+919876543210", "09876543210"],
    ["919876543210", "09876543210"],
    ["00919876543210", "09876543210"],
    ["09876543210", "09876543210"],
    ["(022) 2345 6789", "02223456789"],
    ["2223456789", "02223456789"],
    ["+91 22 2345 6789", "02223456789"],
    ["+1 (415) 555-0132", "0014155550132"],
    ["0014155550132", "0014155550132"],
    ["112", "112"],
    ["198", "198"],
    ["1800 123 4567", "18001234567"],
    ["1800123456", "1800123456"],
    ["*121#", "*121#"],
    ["23456789", "23456789"],
  ])("%s → %s", (input, expected) => {
    expect(dial(input)).toBe(expected);
  });

  it.each(["", "+", "abc", "12", "+91 98765", "+12", "+*121#", "012"])("rejects %j", (input) => {
    expect(toDialString(input).ok).toBe(false);
  });

  it("strips everything a keypad cannot produce", () => {
    expect(sanitizeDialInput("tel:+91 (98765) 43210 ext")).toBe("+919876543210");
    expect(sanitizeDialInput(" +91-98765 43210")).toBe("+919876543210");
    expect(sanitizeDialInput("９８７６５")).toBe("98765");
    expect(sanitizeDialInput("1".repeat(40))).toHaveLength(20);
  });
});

describe("canonical numbers", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["+919876543210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["00919876543210", "+919876543210"],
    ["02223456789", "+912223456789"],
    ["0014155550132", "+14155550132"],
    ["198", "198"],
    ["18001234567", "18001234567"],
    ["anonymous", ""],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(canonicalNumber(input)).toBe(expected);
  });

  it("formats for display", () => {
    expect(formatNumber("09876543210")).toBe("+91 98765 43210");
    expect(formatNumber("+912223456789")).toBe("+91 22 2345 6789");
    expect(formatNumber("198")).toBe("198");
    expect(formatNumber("anonymous")).toBe("");
    expect(formatAsTyped("9876543210")).toBe("98765 43210");
    expect(formatAsTyped("98765")).toBe("98765");
  });
});
