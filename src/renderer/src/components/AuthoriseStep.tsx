import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { OnboardingState } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Spinner() {
  return <LoaderCircle className="animate-spin" aria-hidden />;
}

/**
 * Requests and verifies the router's one-time code. Used on first run and
 * again if the router ever forgets this device.
 */
export function AuthoriseStep({ onboarding }: { onboarding: OnboardingState }) {
  const [code, setCode] = useState("");
  const { phase, error, otpSentTo } = onboarding;
  const codeSent = phase === "otp-sent" || phase === "verifying";

  if (!codeSent) {
    const requesting = phase === "requesting-otp";
    return (
      <div className="grid gap-4">
        <p className="text-muted-foreground text-sm leading-relaxed">
          Your router confirms new devices with a one-time code. It texts the code to the mobile number
          registered with your Jio line, so keep that phone nearby.
        </p>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button size="lg" disabled={requesting} data-shot="request-otp" onClick={() => void window.jiojoin.requestOtp()}>
          {requesting && <Spinner />}
          {requesting ? "Requesting…" : "Request OTP"}
        </Button>
      </div>
    );
  }

  const verifying = phase === "verifying";
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void window.jiojoin.submitOtp(code);
      }}
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        Enter the code sent to{" "}
        <span className="text-foreground font-medium tabular-nums">{otpSentTo || "your registered mobile"}</span>.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="otp">One-time code</Label>
        <Input
          id="otp"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          aria-invalid={error !== ""}
          aria-describedby={error ? "otp-error" : undefined}
          className="h-12 text-center text-2xl tracking-[0.3em] tabular-nums md:text-2xl"
        />
        {error && (
          <p id="otp-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" disabled={code.length < 4 || verifying}>
        {verifying && <Spinner />}
        {verifying ? "Verifying…" : "Verify"}
      </Button>
      <Button
        type="button"
        variant="link"
        size="sm"
        disabled={verifying}
        onClick={() => {
          setCode("");
          void window.jiojoin.requestOtp();
        }}
      >
        Send a new code
      </Button>
    </form>
  );
}
