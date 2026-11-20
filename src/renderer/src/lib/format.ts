import type { LineState, RouterInfo } from "@shared/types";

/** "02:14", or "1:02:14" past an hour. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** "45 sec", "2 min 14 sec", "1 hr 3 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function formatTime(at: number): string {
  return time.format(at);
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** "Today", "Yesterday", a weekday within the last week, otherwise the date. */
export function formatDay(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(at);
  return date.format(at);
}

export interface LineSummary {
  label: string;
  tone: "ok" | "busy" | "warn" | "off";
}

export function summariseLine(line: LineState): LineSummary {
  switch (line.status) {
    case "registered":
      return { label: "Connected", tone: "ok" };
    case "connecting":
      return {
        label:
          line.phase === "registering"
            ? "Registering…"
            : line.phase === "refreshing"
              ? "Signing in…"
              : "Finding router…",
        tone: "busy",
      };
    case "retrying":
      return { label: "Not connected", tone: "warn" };
    case "needs-otp":
      return { label: "Needs authorising", tone: "warn" };
    case "offline":
      return { label: "Disconnected", tone: "off" };
    case "signed-out":
      return { label: "Not set up", tone: "off" };
  }
}

/** Splits "JIDU6911/JUICEJFV-1.5.5" into a model and a voice-service version. */
export function describeRouter(router: RouterInfo): { model: string; service: string } {
  const [model = "", service = ""] = router.server.split("/");
  const version = /(\d+(?:\.\d+)+)/.exec(service)?.[1];
  return { model, service: version ? `JUICE ${version}` : service };
}

export function routerSourceLabel(source: RouterInfo["source"]): string {
  if (source === "dns") return "jiofiber.local.html";
  if (source === "gateway") return "Default gateway";
  return "Address from Settings";
}
