import { Clock, Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { formatNumber } from "@shared/phone";
import type { HistoryEntry, HistoryKind } from "@shared/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatDay, formatDuration, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND: Record<HistoryKind, { label: string; icon: typeof Phone }> = {
  incoming: { label: "Incoming", icon: PhoneIncoming },
  outgoing: { label: "Outgoing", icon: PhoneOutgoing },
  missed: { label: "Missed", icon: PhoneMissed },
  failed: { label: "Didn't connect", icon: PhoneOff },
};

function describe(entry: HistoryEntry): string {
  const { label } = KIND[entry.kind];
  if (entry.durationSec > 0) return `${label} · ${formatDuration(entry.durationSec)}`;
  if (entry.kind === "missed") return entry.reason && entry.reason !== "Missed call" ? entry.reason : label;
  return entry.reason ? `${label} · ${entry.reason}` : label;
}

export function RecentsView({
  entries,
  banner,
  canCall,
  onCall,
}: {
  entries: HistoryEntry[] | null;
  banner?: ReactNode;
  canCall: boolean;
  onCall(number: string): void;
}) {
  const [filter, setFilter] = useState<"all" | "missed">("all");

  // Opening Recents is what acknowledges missed calls.
  useEffect(() => {
    void window.jiojoin.markMissedSeen();
  }, [entries?.[0]?.id]);

  const shown = (entries ?? []).filter((entry) => filter === "all" || entry.kind === "missed");
  let lastDay = "";

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar flex h-[52px] shrink-0 items-center gap-3 px-6">
        <h1 className="text-[15px] font-semibold">Recents</h1>
        <div className="bg-muted ml-auto flex rounded-md p-0.5" role="tablist" aria-label="Filter calls">
          {(["all", "missed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "focus-visible:ring-ring/60 rounded-[5px] px-3 py-1 text-[13px] outline-none focus-visible:ring-[3px]",
                filter === value ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
              )}
            >
              {value === "all" ? "All" : "Missed"}
            </button>
          ))}
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!entries || entries.length === 0}>
              Clear
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear all recent calls?</AlertDialogTitle>
              <AlertDialogDescription>This removes the call history on this computer.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void window.jiojoin.clearHistory()}>
                Clear
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </header>
      {banner}

      {entries === null ? null : shown.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 pb-16 text-center">
          <Clock className="size-9 opacity-50" strokeWidth={1.5} />
          <p className="text-foreground mt-1 text-[15px] font-medium">
            {filter === "missed" ? "No missed calls" : "No recent calls"}
          </p>
          <p className="max-w-64 text-[13px]">
            {filter === "missed"
              ? "Calls you miss while JioJoin is running show up here."
              : "Calls you make and receive on this computer show up here."}
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto px-3 pb-4">
          {shown.map((entry) => {
            const day = formatDay(entry.at);
            const heading = day !== lastDay;
            lastDay = day;
            const Icon = KIND[entry.kind].icon;
            const number = formatNumber(entry.number);
            const dialable = entry.number !== "";
            const alert = entry.kind === "missed" || entry.kind === "failed";
            return (
              <li key={entry.id}>
                {heading && (
                  <h2 className="text-muted-foreground px-3 pt-4 pb-1.5 text-xs font-medium">{day}</h2>
                )}
                <div
                  className="group hover:bg-muted focus-within:bg-muted flex h-14 items-center gap-3 rounded-lg px-3"
                  onDoubleClick={() => dialable && canCall && onCall(entry.number)}
                >
                  <Icon
                    className={cn("size-[18px] shrink-0", alert ? "text-destructive" : "text-muted-foreground")}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "selectable truncate text-[15px] tabular-nums",
                        entry.kind === "missed" && "text-destructive",
                      )}
                    >
                      {number || entry.name || "Unknown caller"}
                    </p>
                    <p className="text-muted-foreground truncate text-[13px]">{describe(entry)}</p>
                  </div>
                  <time className="text-muted-foreground text-[13px] tabular-nums group-focus-within:hidden group-hover:hidden">
                    {formatTime(entry.at)}
                  </time>
                  <div className="hidden items-center gap-1 group-focus-within:flex group-hover:flex">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove call from ${number || "unknown caller"}`}
                      title="Remove"
                      onClick={() => void window.jiojoin.deleteHistory(entry.id)}
                    >
                      <X />
                    </Button>
                    {dialable && (
                      <Button
                        size="sm"
                        variant="call"
                        disabled={!canCall}
                        aria-label={`Call ${number}`}
                        onClick={() => onCall(entry.number)}
                      >
                        <Phone fill="currentColor" strokeWidth={0} />
                        Call
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
