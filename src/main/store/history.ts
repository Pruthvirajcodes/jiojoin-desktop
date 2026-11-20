import { randomUUID } from "node:crypto";
import type { HistoryEntry } from "@shared/types";
import { readJson, removeFile, writeJson } from "./files";

const MAX_ENTRIES = 500;

/** Call history, newest first. Small enough to keep whole in memory. */
export class HistoryStore {
  private entries: HistoryEntry[];

  constructor(
    private readonly path: string,
    private readonly onChange: (entries: HistoryEntry[]) => void,
  ) {
    const stored = readJson<HistoryEntry[]>(path, []);
    this.entries = Array.isArray(stored) ? stored.slice(0, MAX_ENTRIES) : [];
  }

  list(): HistoryEntry[] {
    return this.entries;
  }

  missedCount(): number {
    return this.entries.filter((entry) => entry.kind === "missed" && !entry.seen).length;
  }

  add(entry: Omit<HistoryEntry, "id" | "seen">): void {
    this.entries = [
      { ...entry, id: randomUUID(), seen: entry.kind !== "missed" },
      ...this.entries,
    ].slice(0, MAX_ENTRIES);
    this.save();
  }

  remove(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.save();
  }

  markMissedSeen(): void {
    if (this.missedCount() === 0) return;
    this.entries = this.entries.map((entry) => (entry.seen ? entry : { ...entry, seen: true }));
    this.save();
  }

  clear(): void {
    this.entries = [];
    removeFile(this.path);
    this.onChange(this.entries);
  }

  private save(): void {
    writeJson(this.path, this.entries);
    this.onChange(this.entries);
  }
}
