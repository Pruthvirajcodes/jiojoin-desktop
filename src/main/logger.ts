import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createRedactor } from "@shared/redact";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MEMORY_LINES = 1500;

/**
 * The only path to the log file and the diagnostics export. Every line is
 * redacted on the way in, so nothing downstream can leak an identity.
 */
export class Logger {
  private readonly redactor = createRedactor();
  private readonly lines: string[] = [];
  private path = "";

  setFile(path: string): void {
    this.path = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      this.path = "";
    }
  }

  /** Registers a value that must never appear in output, whatever the context. */
  addSecret(value: string | undefined | null): void {
    this.redactor.addSecret(value);
  }

  redact(text: string): string {
    return this.redactor.redact(text);
  }

  info(scope: string, message: string): void {
    this.write("info", scope, message);
  }

  warn(scope: string, message: string): void {
    this.write("warn", scope, message);
  }

  error(scope: string, message: string): void {
    this.write("error", scope, message);
  }

  recent(): string[] {
    return [...this.lines];
  }

  private write(level: string, scope: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} [${scope}] ${this.redactor.redact(message)}`;
    this.lines.push(line);
    if (this.lines.length > MAX_MEMORY_LINES) this.lines.shift();
    if (!this.path) return;
    try {
      try {
        if (statSync(this.path).size > MAX_FILE_BYTES) renameSync(this.path, `${this.path}.1`);
      } catch {
        // No file yet.
      }
      appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the app down.
    }
  }
}

export const log = new Logger();
