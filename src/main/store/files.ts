import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Writes via a temporary file so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}

export function removeFile(path: string): void {
  rmSync(path, { force: true });
}
