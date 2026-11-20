import { type ReactNode, useEffect, useState } from "react";
import type { AppState, AudioLevel } from "@shared/types";
import { DeviceSelect, useAudioDevices } from "@/components/DevicePickers";
import { StatusDot } from "@/components/StatusDot";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { describeRouter, routerSourceLabel, summariseLine } from "@/lib/format";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-muted-foreground mb-2 px-1 text-xs font-medium">{title}</h2>
      <div className="bg-card divide-border divide-y rounded-xl border">{children}</div>
    </section>
  );
}

function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-12 items-center gap-4 px-4 py-2.5 ${className}`}>{children}</div>;
}

function RowText({ title, detail }: { title: string; detail?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm">{title}</p>
      {detail && <p className="text-muted-foreground mt-0.5 text-[13px]">{detail}</p>}
    </div>
  );
}

function MicrophoneTest() {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!testing) return;
    const off = window.jiojoin.on("level", (value: AudioLevel) => setLevel(value.mic));
    // The microphone is only opened for the test, and never left on.
    const limit = setTimeout(() => setTesting(false), 20_000);
    return () => {
      off();
      clearTimeout(limit);
      setLevel(0);
      void window.jiojoin.setMeter(false);
    };
  }, [testing]);

  const toggle = async () => {
    setError("");
    if (testing) {
      setTesting(false);
      return;
    }
    const result = await window.jiojoin.setMeter(true);
    if (result.ok) setTesting(true);
    else setError(result.error ?? "The microphone couldn't be opened.");
  };

  // Speech peaks around 100 on the engine's 0–255 scale.
  const percent = Math.min(100, Math.round((level / 140) * 100));

  return (
    <div className="flex items-center gap-3">
      <div
        className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={testing ? percent : 0}
      >
        <div className="bg-call h-full rounded-full transition-[width] duration-100" style={{ width: `${percent}%` }} />
      </div>
      <Button variant="outline" size="sm" onClick={() => void toggle()} aria-pressed={testing}>
        {testing ? "Stop" : "Test microphone"}
      </Button>
      {error && (
        <p role="alert" className="text-destructive basis-full text-[13px]">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsView({ state }: { state: AppState }) {
  const { settings, line, router, account } = state;
  const { audio, reload, choose } = useAudioDevices();
  const [routerDraft, setRouterDraft] = useState(settings.routerOverride);
  const [exported, setExported] = useState("");
  const [toneError, setToneError] = useState("");
  const summary = summariseLine(line);
  const trayName = state.platform === "darwin" ? "menu bar" : "system tray";

  const saveRouter = () => {
    if (routerDraft.trim() !== settings.routerOverride) {
      void window.jiojoin.updateSettings({ routerOverride: routerDraft.trim() });
    }
  };

  const exportDiagnostics = async () => {
    const result = await window.jiojoin.exportDiagnostics();
    if (result.ok) setExported("Saved.");
    else if (result.error) setExported(result.error);
  };

  const routerDetail = router ? describeRouter(router) : null;

  return (
    <div className="h-full overflow-y-auto">
      <header className="titlebar bg-background sticky top-0 z-10">
        <div className="mx-auto flex h-[52px] max-w-xl items-center px-7">
          <h1 className="text-[15px] font-semibold">Settings</h1>
        </div>
      </header>
      <div className="mx-auto max-w-xl px-6 pb-10">
        <Section title="Line">
          <Row>
            <RowText title="Your number" />
            <span className="selectable text-muted-foreground tabular-nums">{account?.number}</span>
          </Row>
          <Row>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm">
                <StatusDot tone={summary.tone} />
                {summary.label}
              </p>
              {line.detail && <p className="text-muted-foreground mt-0.5 text-[13px]">{line.detail}</p>}
            </div>
            {line.status === "registered" || line.status === "connecting" ? (
              <Button variant="outline" size="sm" onClick={() => void window.jiojoin.disconnect()}>
                Disconnect
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void window.jiojoin.reconnect()}>
                {line.status === "retrying" ? "Retry now" : "Connect"}
              </Button>
            )}
          </Row>
          <Row>
            <RowText title="Router" />
            <span className="text-muted-foreground text-right text-[13px] tabular-nums">
              {router ? (
                <>
                  {router.address}
                  {routerDetail?.model && ` · ${routerDetail.model}`}
                  <br />
                  via {routerSourceLabel(router.source)}
                </>
              ) : (
                "Not found yet"
              )}
            </span>
          </Row>
        </Section>

        <Section title="Audio">
          <div className="grid gap-3 px-4 py-3.5">
            <DeviceSelect id="input" label="Microphone" kind="input" audio={audio} onChoose={choose} onOpen={reload} />
            <MicrophoneTest />
          </div>
          <div className="grid gap-3 px-4 py-3.5">
            <DeviceSelect id="output" label="Speaker" kind="output" audio={audio} onChoose={choose} onOpen={reload} />
            <div className="flex items-center gap-3">
              <p className="text-muted-foreground flex-1 text-[13px]">
                {toneError || "Calls and the ringtone play through this device."}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const result = await window.jiojoin.playTestTone();
                  setToneError(result.ok ? "" : (result.error ?? "The speaker couldn't be opened."));
                }}
              >
                Play test tone
              </Button>
            </div>
          </div>
        </Section>

        <Section title="General">
          <Row>
            <RowText
              title="Open at login"
              detail="Incoming calls only ring while JioJoin is running."
            />
            <Switch
              aria-label="Open at login"
              checked={settings.launchAtLogin}
              onCheckedChange={(launchAtLogin) => void window.jiojoin.updateSettings({ launchAtLogin })}
            />
          </Row>
          <Row>
            <RowText title={`Start in the ${trayName}`} detail="Open without showing the window." />
            <Switch
              aria-label={`Start in the ${trayName}`}
              checked={settings.startHidden}
              onCheckedChange={(startHidden) => void window.jiojoin.updateSettings({ startHidden })}
            />
          </Row>
          <Row>
            <RowText title="Appearance" />
            <Select
              value={settings.theme}
              onValueChange={(theme) => void window.jiojoin.updateSettings({ theme: theme as typeof settings.theme })}
            >
              <SelectTrigger size="sm" className="w-32" aria-label="Appearance">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </Section>

        <Section title="Router">
          <div className="grid gap-1.5 px-4 py-3.5">
            <Label htmlFor="router">Router address</Label>
            <div className="flex gap-2">
              <Input
                id="router"
                value={routerDraft}
                placeholder="Automatic"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setRouterDraft(event.target.value)}
                onBlur={saveRouter}
                onKeyDown={(event) => event.key === "Enter" && saveRouter()}
              />
              {routerDraft !== "" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setRouterDraft("");
                    void window.jiojoin.updateSettings({ routerOverride: "" });
                  }}
                >
                  Use automatic
                </Button>
              )}
            </div>
            <p className="text-muted-foreground text-[13px]">
              Leave empty to find the router by its name, jiofiber.local.html, or your default gateway. Enter
              an address only if that fails on your network.
            </p>
          </div>
        </Section>

        <Section title="Help">
          <Row>
            <RowText
              title="Diagnostics"
              detail={exported || "A report with numbers, names and device identifiers removed."}
            />
            <Button variant="outline" size="sm" onClick={() => void exportDiagnostics()}>
              Export…
            </Button>
          </Row>
        </Section>

        <Section title="This device">
          <Row>
            <RowText
              title={account?.deviceName ?? ""}
              detail={
                state.storage === "keychain"
                  ? "Authorised on your router. The sign-in is kept in your system keychain."
                  : state.storage === "file"
                    ? "Authorised on your router. No system keychain is available, so the sign-in is kept in a file only your user account can read."
                    : "Authorised on your router, but the sign-in couldn't be saved. You'll need to set up again after quitting."
              }
            />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Sign out…
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sign out of this line?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes your line's details and call history from this computer. It keeps this
                    computer's device ID, so if you sign in again the router can recognise it without using up
                    another device slot.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void window.jiojoin.signOut()}>
                    Sign out
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Row>
        </Section>

        <p className="text-muted-foreground px-1 text-xs">
          JioJoin Desktop {state.version}
          {state.engine.ready && ` · calling engine ${state.engine.version}`}
          {state.demo && " · demo mode, no real calls"}
        </p>
      </div>
    </div>
  );
}
