import { CircleAlert, Clock, Grip, Settings } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { AppState, MainView } from "@shared/types";
import { AuthoriseStep } from "@/components/AuthoriseStep";
import { StatusDot } from "@/components/StatusDot";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { summariseLine } from "@/lib/format";
import { useAppState, useHistory } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CallView } from "@/views/CallView";
import { DialerView } from "@/views/DialerView";
import { Onboarding } from "@/views/Onboarding";
import { RecentsView } from "@/views/RecentsView";
import { SettingsView } from "@/views/SettingsView";

const NAV: readonly { view: MainView; label: string; icon: typeof Grip }[] = [
  { view: "keypad", label: "Keypad", icon: Grip },
  { view: "recents", label: "Recents", icon: Clock },
  { view: "settings", label: "Settings", icon: Settings },
];

function Banner({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div
      role="status"
      className="bg-warning-surface border-warning-border text-warning mx-4 flex items-center gap-2.5 rounded-lg border py-2 pr-2 pl-3.5 text-[13px]"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">{children}</p>
      {action}
    </div>
  );
}

function LineBanner({ state, onAuthorise }: { state: AppState; onAuthorise(): void }) {
  const { line } = state;
  if (line.status === "retrying") {
    return (
      <Banner
        action={
          <Button variant="outline" size="sm" onClick={() => void window.jiojoin.reconnect()}>
            Retry now
          </Button>
        }
      >
        {line.detail || "Not connected."} Trying again automatically.
      </Banner>
    );
  }
  if (line.status === "offline") {
    return (
      <Banner
        action={
          <Button variant="outline" size="sm" onClick={() => void window.jiojoin.reconnect()}>
            Connect
          </Button>
        }
      >
        You're disconnected, so calls won't ring here.
      </Banner>
    );
  }
  if (line.status === "needs-otp") {
    return (
      <Banner
        action={
          <Button variant="outline" size="sm" onClick={onAuthorise}>
            Authorise…
          </Button>
        }
      >
        Your router needs to confirm this device again.
      </Banner>
    );
  }
  return null;
}

function Shell({ state }: { state: AppState }) {
  const [view, setView] = useState<MainView>("keypad");
  const [number, setNumber] = useState("");
  const [authorising, setAuthorising] = useState(false);
  const history = useHistory();
  const summary = summariseLine(state.line);
  const needsOtp = state.line.status === "needs-otp";

  useEffect(() => window.jiojoin.on("navigate", setView), []);
  useEffect(() => {
    if (!needsOtp) setAuthorising(false);
  }, [needsOtp]);

  const banner = <LineBanner state={state} onAuthorise={() => setAuthorising(true)} />;

  return (
    <div className="flex h-full">
      <aside className="bg-sidebar border-sidebar-border flex w-[200px] shrink-0 flex-col border-r">
        <div className="drag flex h-[52px] shrink-0 items-end px-4 pb-1.5">
          {state.platform !== "darwin" && <span className="text-[13px] font-semibold">JioJoin</span>}
        </div>
        <nav className="flex flex-col gap-0.5 px-2.5" aria-label="Sections">
          {NAV.map(({ view: target, label, icon: Icon }) => (
            <button
              key={target}
              type="button"
              aria-current={view === target ? "page" : undefined}
              onClick={() => setView(target)}
              className={cn(
                "focus-visible:ring-ring/60 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-[3px]",
                view === target ? "bg-accent font-medium" : "hover:bg-accent/60",
              )}
            >
              <Icon className={cn("size-4", view === target ? "text-primary" : "text-muted-foreground")} aria-hidden />
              <span className="flex-1">{label}</span>
              {target === "recents" && state.missedCount > 0 && (
                <span
                  className="bg-destructive min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold text-white"
                  aria-label={`${state.missedCount} missed`}
                >
                  {state.missedCount}
                </span>
              )}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => setView("settings")}
          title="Line status"
          className="hover:bg-accent/60 focus-visible:ring-ring/60 mx-2.5 mt-auto mb-3 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-[3px]"
        >
          <span className="flex items-center gap-2 text-[13px]">
            <StatusDot tone={summary.tone} />
            {summary.label}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate pl-4 text-xs tabular-nums">
            {state.account?.number}
          </span>
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {view === "keypad" && (
          <>
            <div className="titlebar h-[52px] shrink-0" />
            {banner}
          </>
        )}
        <div className="min-h-0 flex-1">
          {view === "keypad" && <DialerView state={state} number={number} onNumberChange={setNumber} />}
          {view === "recents" && (
            <RecentsView
              entries={history}
              banner={banner}
              canCall={state.line.status === "registered"}
              onCall={(target) => void window.jiojoin.dial(target)}
            />
          )}
          {view === "settings" && <SettingsView state={state} />}
        </div>
      </main>

      <AlertDialog open={authorising && needsOtp} onOpenChange={setAuthorising}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm this device</AlertDialogTitle>
            <AlertDialogDescription>
              Your router no longer has this computer on its list of allowed devices.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AuthoriseStep onboarding={state.onboarding} />
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function App() {
  const state = useAppState();
  // Stays true through the "all set" screen, until the user dismisses it.
  const [settingUp, setSettingUp] = useState<boolean | null>(null);

  useEffect(() => {
    if (state) document.documentElement.dataset.platform = state.platform;
  }, [state?.platform]);
  useEffect(() => {
    if (!state) return;
    if (settingUp === null) setSettingUp(state.account === null);
    else if (state.account === null && !settingUp) setSettingUp(true);
  }, [state?.account, settingUp]);

  if (!state || settingUp === null) return <div className="drag h-full" />;
  if (settingUp) return <Onboarding state={state} onDone={() => setSettingUp(false)} />;
  if (state.call) return <CallView call={state.call} />;
  return <Shell state={state} />;
}
