import { parsePhoneNumberFromString } from "libphonenumber-js/min";

/**
 * Number handling for an Indian fixed line.
 *
 * Dial strings follow what a Jio landline expects: national numbers with the
 * trunk prefix 0 (mandatory for fixed-to-mobile calls since 2021), 00 for
 * international calls, and short or service codes untouched.
 */

const MAX_DIGITS = 20;

/** Keeps only what a keypad can produce; "+" survives only as the first character. */
export function sanitizeDialInput(raw: string): string {
  let out = "";
  for (const ch of raw.normalize("NFKC")) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "*" || ch === "#") out += ch;
    else if (ch === "+" && out === "") out += ch;
  }
  return out.slice(0, MAX_DIGITS);
}

export type DialResult = { ok: true; dial: string } | { ok: false; reason: string };

/** Turns what the user typed or pasted into the digits sent to the network. */
export function toDialString(raw: string): DialResult {
  const input = sanitizeDialInput(raw);
  if (input === "" || input === "+") return { ok: false, reason: "Enter a number to call." };

  if (/[*#]/.test(input)) {
    if (input.startsWith("+")) return { ok: false, reason: "That isn't a valid number." };
    return { ok: true, dial: input };
  }

  if (input.startsWith("+")) {
    const digits = input.slice(1);
    if (digits.startsWith("91")) return nationalFrom(digits.slice(2));
    if (digits.length < 7) return { ok: false, reason: "That number is too short." };
    return { ok: true, dial: `00${digits}` };
  }

  if (input.startsWith("0091")) return nationalFrom(input.slice(4));
  if (input.startsWith("00")) {
    if (input.length < 9) return { ok: false, reason: "That number is too short." };
    return { ok: true, dial: input };
  }
  if (input.startsWith("0")) {
    if (input.length < 9) return { ok: false, reason: "That number is too short." };
    return { ok: true, dial: input };
  }
  if (input.length === 12 && input.startsWith("91")) return nationalFrom(input.slice(2));
  // Ten digits not starting with 1 are a mobile number or STD code + number.
  if (input.length === 10 && !input.startsWith("1")) return { ok: true, dial: `0${input}` };
  if (input.length < 3) return { ok: false, reason: "That number is too short." };
  // Short codes (112, 198), toll-free 1800 numbers and local numbers go out as typed.
  return { ok: true, dial: input };
}

function nationalFrom(national: string): DialResult {
  if (national.length !== 10) return { ok: false, reason: "Indian numbers have 10 digits." };
  return { ok: true, dial: `0${national}` };
}

/**
 * One stable form per subscriber, used to store and compare numbers:
 * "+91XXXXXXXXXX" for Indian numbers, "+<digits>" for international ones,
 * bare digits for short codes. Returns "" for a withheld or unusable number.
 */
export function canonicalNumber(raw: string): string {
  const input = sanitizeDialInput(raw);
  if (input === "" || input === "+") return "";
  if (/[*#]/.test(input)) return input;
  if (input.startsWith("+")) return input;
  if (input.startsWith("0091") && input.length === 14) return `+91${input.slice(4)}`;
  if (input.startsWith("00") && input.length >= 9) return `+${input.slice(2)}`;
  if (input.startsWith("0") && input.length === 11) return `+91${input.slice(1)}`;
  if (input.length === 12 && input.startsWith("91")) return `+${input}`;
  if (input.length === 10 && !input.startsWith("1")) return `+91${input}`;
  return input;
}

/** Human-readable form for lists and the call screen. */
export function formatNumber(raw: string): string {
  const canonical = canonicalNumber(raw);
  if (canonical === "") return "";
  if (!canonical.startsWith("+")) return canonical;
  const parsed = parsePhoneNumberFromString(canonical);
  if (!parsed?.isPossible()) return canonical;
  return parsed.formatInternational();
}

/** Formats a partly typed number without changing which digits it contains. */
export function formatAsTyped(input: string): string {
  if (input.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(input);
    return parsed?.isPossible() ? parsed.formatInternational() : input;
  }
  if (/^[6-9]\d{9}$/.test(input)) return `${input.slice(0, 5)} ${input.slice(5)}`;
  if (/^0[6-9]\d{9}$/.test(input)) return `${input.slice(0, 6)} ${input.slice(6)}`;
  return input;
}
