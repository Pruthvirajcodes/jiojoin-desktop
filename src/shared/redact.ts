/**
 * Scrubs identities from text before it reaches a log file or a diagnostics
 * export. Secrets must never be logged in the first place; this is the second
 * line of defence for identifiers that appear inside library output.
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const MAC = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi;
const SIP_USER = /\b(sips?|tel):([^@\s;>"']+)@/gi;
const TEL = /\btel:[+\d][\d\-.()]*/gi;
// Global IPv6 addresses identify the subscriber's connection.
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}(?::?[0-9a-f]{1,4}){1,6}\b/gi;
const DIGIT_RUN = /\+?\d(?:[ -]?\d){5,}/g;
const DATE = /^\d{4}-\d{2}-\d{2}/;

export function createRedactor(): {
  addSecret(value: string | undefined | null): void;
  redact(text: string): string;
} {
  const secrets = new Set<string>();

  return {
    addSecret(value) {
      if (!value) return;
      const trimmed = value.trim();
      // Very short values would shred ordinary text.
      if (trimmed.length >= 4) secrets.add(trimmed);
    },
    redact(text) {
      let out = text;
      // Longest first so one secret containing another is removed whole.
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        out = out.split(secret).join("‹redacted›");
      }
      return redactPatterns(out);
    },
  };
}

export function redactPatterns(text: string): string {
  return text
    .replace(UUID, "‹uuid›")
    .replace(MAC, "‹device-id›")
    .replace(SIP_USER, "$1:‹user›@")
    .replace(TEL, "tel:‹number›")
    .replace(IPV6, (match) => (match.includes("::") || match.split(":").length > 3 ? "‹ipv6›" : match))
    .replace(DIGIT_RUN, (match) => (DATE.test(match) ? match : "‹number›"));
}
