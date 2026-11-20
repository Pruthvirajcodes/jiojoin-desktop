import { Phone } from "lucide-react";
import { formatNumber } from "@shared/phone";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/lib/store";

/** The always-on-top card shown while the line is ringing. */
export function IncomingPopup() {
  const state = useAppState();
  const call = state?.call;
  if (!call || call.state !== "incoming") return null;
  const title = formatNumber(call.number) || call.name || "Unknown caller";

  return (
    <div className="drag bg-popover text-popover-foreground flex h-full flex-col justify-between rounded-2xl border p-4">
      <div className="flex items-center gap-3">
        <span className="bg-call flex size-10 shrink-0 items-center justify-center rounded-full text-white">
          <Phone className="size-5" fill="currentColor" strokeWidth={0} />
        </span>
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs">Incoming call</p>
          <p className="truncate text-lg leading-tight font-medium tabular-nums">{title}</p>
        </div>
      </div>
      <div className="no-drag grid grid-cols-2 gap-2">
        <Button variant="hangup" onClick={() => void window.jiojoin.hangup()}>
          Decline
        </Button>
        <Button
          variant="call"
          autoFocus
          onClick={() => {
            void window.jiojoin.answer();
            void window.jiojoin.showMainWindow();
          }}
        >
          Answer
        </Button>
      </div>
    </div>
  );
}
