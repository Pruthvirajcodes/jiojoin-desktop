import { CircleAlert, CircleCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { AppState } from "@shared/types";
import { AuthoriseStep, Spinner } from "@/components/AuthoriseStep";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeRouter, routerSourceLabel } from "@/lib/format";

type Step = "router" | "device" | "authorise";

function AppMark() {
  return (
    <svg viewBox="0 0 64 64" className="size-12" aria-hidden>
      <defs>
        <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5fdc74" />
          <stop offset="1" stopColor="#1fae48" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14.5" fill="url(#mark)" />
      <path
        transform="translate(32 32) scale(1.5) translate(-12 -12)"
        fill="#fff"
        d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
      />
    </svg>
  );
}

function Frame({ step, title, children }: { step?: number; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-8">
        {/* min-h-full keeps short steps centred and lets tall ones scroll from the top. */}
        <div className="flex min-h-full items-center justify-center pb-10">
          <div className="w-full max-w-[400px]">
            <AppMark />
            <p className="text-muted-foreground mt-5 h-5 text-[13px]">{step ? `Step ${step} of 3` : ""}</p>
            <h1 className="mt-1 mb-4 text-2xl font-semibold tracking-tight">{title}</h1>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className="text-muted-foreground text-[13px]">{label}</dt>
      <dd className="selectable text-right text-sm tabular-nums">{children}</dd>
    </div>
  );
}

function RouterStep({ state, onContinue }: { state: AppState; onContinue(): void }) {
  const { discovery } = state.onboarding;
  const [address, setAddress] = useState(state.settings.routerOverride);

  const retry = async () => {
    await window.jiojoin.updateSettings({ routerOverride: address.trim() });
    await window.jiojoin.discover();
  };

  if (discovery.status === "found") {
    const { model, service } = describeRouter(discovery.router);
    return (
      <Frame step={1} title="Jio router found">
        {state.onboarding.notice && (
          <div className="bg-warning-surface border-warning-border text-warning mb-4 flex gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p role="alert">{state.onboarding.notice}</p>
          </div>
        )}
        <p className="text-muted-foreground mb-5 text-sm leading-relaxed">
          JioJoin places calls through your router's calling service, so it works on your home network.
        </p>
        <dl className="bg-card divide-border mb-6 divide-y rounded-xl border">
          <div className="flex items-center gap-2.5 px-4 py-3">
            <CircleCheck className="text-call size-5 shrink-0" aria-hidden />
            <span className="text-sm font-medium">Calling service is running</span>
          </div>
          <Fact label="Router">{model || "Jio router"}</Fact>
          <Fact label="Address">{discovery.router.address}</Fact>
          <Fact label="Found via">{routerSourceLabel(discovery.router.source)}</Fact>
          {service && <Fact label="Voice service">{service}</Fact>}
        </dl>
        <Button size="lg" className="w-full" autoFocus data-shot="continue" onClick={onContinue}>
          Continue
        </Button>
      </Frame>
    );
  }

  if (discovery.status === "not-found") {
    return (
      <Frame step={1} title="Can't find your Jio router">
        <div className="bg-warning-surface border-warning-border text-warning mb-4 flex gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p role="alert">{discovery.reason}</p>
        </div>
        <ul className="text-muted-foreground mb-5 list-disc space-y-1 pl-5 text-[13px] leading-relaxed">
          <li>Connect this computer to your JioFiber or AirFiber Wi-Fi or LAN, not a guest network or hotspot.</li>
          <li>Turn off any VPN, and custom or private DNS, then try again.</li>
          <li>If the router restarted, give its calling service a minute to come up.</li>
        </ul>
        <div className="mb-5 grid gap-1.5">
          <Label htmlFor="router-address">Router address (optional)</Label>
          <Input
            id="router-address"
            value={address}
            placeholder="For example 192.168.29.1"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void retry()}
          />
        </div>
        <Button size="lg" className="w-full" onClick={() => void retry()}>
          Try again
        </Button>
      </Frame>
    );
  }

  return (
    <Frame step={1} title="Looking for your Jio router">
      <p className="text-muted-foreground flex items-center gap-2.5 text-sm" role="status">
        <Spinner />
        Checking your network…
      </p>
    </Frame>
  );
}

function DeviceStep({ state, onBack, onChecked }: { state: AppState; onBack(): void; onChecked(): void }) {
  const [name, setName] = useState(state.defaultDeviceName);
  const checking = state.onboarding.phase === "checking";

  const submit = async () => {
    // Move on only when the router said this device needs a code; on an error
    // stay here with the message, so nobody requests a code by mistake.
    if ((await window.jiojoin.checkDevice(name)) === "authorise") onChecked();
  };

  return (
    <Frame step={2} title="Name this device">
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-muted-foreground text-sm leading-relaxed">
          Your router keeps a list of devices allowed to use the line. This name tells them apart.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="device-name">Device name</Label>
          <Input
            id="device-name"
            value={name}
            maxLength={32}
            autoFocus
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {state.onboarding.error && (
          <p role="alert" className="text-destructive text-sm">
            {state.onboarding.error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="lg" onClick={onBack} disabled={checking}>
            Back
          </Button>
          <Button type="submit" size="lg" className="flex-1" disabled={name.trim() === "" || checking} data-shot="continue">
            {checking && <Spinner />}
            {checking ? "Checking…" : "Continue"}
          </Button>
        </div>
      </form>
    </Frame>
  );
}

/** First-run setup: find the router, name the device, confirm with an OTP if the router asks. */
export function Onboarding({ state, onDone }: { state: AppState; onDone(): void }) {
  const [step, setStep] = useState<Step>("router");

  if (state.account) {
    return (
      <Frame title="You're all set">
        <p className="text-muted-foreground mb-5 text-sm leading-relaxed">
          This computer can now make and receive calls on your Jio line.
        </p>
        <dl className="bg-card divide-border mb-6 divide-y rounded-xl border">
          <Fact label="Your number">{state.account.number}</Fact>
          <Fact label="This device">{state.account.deviceName}</Fact>
        </dl>
        <p className="text-muted-foreground mb-6 text-[13px] leading-relaxed">
          Incoming calls ring only while JioJoin is running. Closing the window keeps it in the{" "}
          {state.platform === "darwin" ? "menu bar" : "system tray"}.
        </p>
        <Button size="lg" className="w-full" autoFocus data-shot="continue" onClick={onDone}>
          Start using JioJoin
        </Button>
      </Frame>
    );
  }

  if (step === "router" || state.onboarding.discovery.status !== "found") {
    return <RouterStep state={state} onContinue={() => setStep("device")} />;
  }
  if (step === "device") {
    return <DeviceStep state={state} onBack={() => setStep("router")} onChecked={() => setStep("authorise")} />;
  }
  return (
    <Frame step={3} title="Confirm it's you">
      <AuthoriseStep onboarding={state.onboarding} />
      <Button
        variant="ghost"
        size="sm"
        className="mt-3 w-full"
        onClick={() => {
          void window.jiojoin.cancelOnboarding();
          setStep("device");
        }}
      >
        Back
      </Button>
    </Frame>
  );
}
