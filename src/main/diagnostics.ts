import { release } from "node:os";
import type { AppState, HistoryEntry } from "@shared/types";
import type { Logger } from "./logger";

/**
 * A plain-text report safe to send to someone else: no numbers, names,
 * passwords or device identifiers. Everything passes through the logger's
 * redactor, including values it has been told are secret.
 */
export function buildDiagnostics(state: AppState, history: HistoryEntry[], logger: Logger): string {
  const counts = { incoming: 0, outgoing: 0, missed: 0, failed: 0 };
  for (const entry of history) counts[entry.kind]++;

  const report = [
    "JioJoin Desktop diagnostics",
    `Generated: ${new Date().toISOString()}`,
    "Identities (numbers, names, device ids, addresses outside your LAN) are redacted.",
    "",
    "== App ==",
    `Version: ${state.version}`,
    `Platform: ${state.platform} ${release()} (${process.arch})`,
    `Electron: ${process.versions.electron}`,
    `Sign-in storage: ${state.storage}`,
    "",
    "== Engine ==",
    `Ready: ${state.engine.ready ? "yes" : "no"}`,
    `Version: ${state.engine.version || "-"}`,
    `Codecs: ${state.engine.codecs.join(", ") || "-"}`,
    `Error: ${state.engine.error || "-"}`,
    "",
    "== Line ==",
    `Set up: ${state.account ? "yes" : "no"}`,
    `Status: ${state.line.status}${state.line.phase ? ` (${state.line.phase})` : ""}`,
    `Detail: ${state.line.detail || "-"}`,
    `Attempt: ${state.line.attempt}`,
    "",
    "== Router ==",
    `Address: ${state.router?.address ?? "-"} (${state.router?.source ?? "-"})`,
    `Voice gateway: ${state.router?.server || "-"}`,
    `Manual override: ${state.settings.routerOverride ? "yes" : "no"}`,
    "",
    "== Settings ==",
    `Launch at login: ${state.settings.launchAtLogin}`,
    `Start hidden: ${state.settings.startHidden}`,
    `Custom input device: ${state.settings.inputDevice ? "yes" : "no"}`,
    `Custom output device: ${state.settings.outputDevice ? "yes" : "no"}`,
    "",
    "== Call history (counts only) ==",
    `Incoming ${counts.incoming}, outgoing ${counts.outgoing}, missed ${counts.missed}, failed ${counts.failed}`,
    "",
    "== Recent log ==",
    ...logger.recent(),
    "",
  ].join("\n");

  return logger.redact(report);
}
