import { formatNumber } from "@shared/phone";
import type { CheckOutcome, OnboardingState } from "@shared/types";
import { type Backend, enrolDevice, fetchCredentials, submitOtp } from "./backend";
import { log } from "./logger";
import { provisioningRefusal, routerFailure } from "./reasons";
import { discoverRouter } from "./router/discovery";
import { RouterHttpError } from "./router/http";
import {
  type ProvisionedLine,
  type ProvisioningIdentity,
  type ProvisioningReply,
  isValidOtp,
  numberFromIdentity,
} from "./router/provisioning";
import type { StateStore } from "./store/state";
import { type Vault, generateDeviceId } from "./store/vault";

export const INITIAL_ONBOARDING: OnboardingState = {
  discovery: { status: "idle" },
  phase: "idle",
  otpSentTo: "",
  error: "",
};

interface Deps {
  backend: Backend;
  store: StateStore;
  vault: Vault;
  onAuthorised(): void;
}

/**
 * Authorises this device with the router: first run, and again if the router
 * ever forgets the device. Only `requestOtp` can make the router send a text.
 */
export class OnboardingController {
  private identity: ProvisioningIdentity | null = null;
  private session: { cookie: string; address: string } | null = null;
  /** Bumped by Back and sign-out, so a reply to an abandoned step is ignored. */
  private generation = 0;

  constructor(private readonly deps: Deps) {}

  async discover(): Promise<void> {
    this.patch({ discovery: { status: "searching" }, error: "" });
    const discovery = await discoverRouter(
      this.deps.backend.discovery,
      this.deps.store.get().settings.routerOverride,
    );
    this.patch({ discovery });
    if (discovery.status === "found") {
      this.deps.store.update({ router: discovery.router });
      log.info("onboarding", `router found at ${discovery.router.address} via ${discovery.router.source} (${discovery.router.server})`);
    } else if (discovery.status === "not-found") {
      log.warn("onboarding", `router not found: ${discovery.reason}`);
    }
  }

  /**
   * Asks whether the router already knows this device. Cannot trigger an OTP.
   * The setup screen moves on only for "authorise".
   */
  async checkDevice(deviceName: string): Promise<CheckOutcome> {
    const address = this.routerAddress();
    if (!address) return "retry";
    const existing = this.deps.vault.get();
    this.identity = {
      deviceId: existing?.deviceId ?? this.identity?.deviceId ?? generateDeviceId(),
      deviceName: deviceName.trim() || "Desktop",
    };
    log.addSecret(this.identity.deviceId);
    // Keep the id from the start, so a restart halfway through setup asks the
    // router about the same device instead of minting another one.
    // (Not over a sign-in the keychain refused to read: that one may come back.)
    if (!existing && !this.deps.vault.unreadable) {
      await this.deps.vault.set({ ...this.identity, number: "", onboarded: false });
    }
    const generation = this.generation;
    this.patch({ phase: "checking", error: "" });
    try {
      const reply = await fetchCredentials(this.deps.backend, address, this.identity);
      if (generation !== this.generation) return "retry";
      switch (reply.kind) {
        case "config":
          await this.complete(reply.line);
          return "done";
        case "otp-required":
          this.adoptChallenge({ ...reply, address });
          return "authorise";
        case "not-authorised":
          this.patch({ phase: "needs-otp" });
          return "authorise";
        case "rejected":
          this.patch({ phase: "idle", error: provisioningRefusal(reply) });
          return "retry";
      }
    } catch (error) {
      if (generation === this.generation) this.fail("idle", error);
      return "retry";
    }
  }

  /** The one action that makes the router text a code to the line's owner. */
  async requestOtp(): Promise<void> {
    const address = this.routerAddress();
    const identity = this.currentIdentity();
    if (!address || !identity) return;
    const generation = this.generation;
    this.patch({ phase: "requesting-otp", error: "" });
    try {
      const reply = await enrolDevice(this.deps.backend, address, identity);
      // A text may already be on its way; only the screen state is dropped.
      if (generation !== this.generation) return;
      if (reply.kind === "config") await this.complete(reply.line);
      else if (reply.kind === "otp-required") this.adoptChallenge({ ...reply, address });
      else {
        log.warn("onboarding", `enrol refused: ${reply.kind === "rejected" ? reply.reason : reply.kind}`);
        const error =
          reply.kind === "rejected" && reply.status !== 200
            ? `${provisioningRefusal(reply)} Wait a minute and try again.`
            : "The router didn't send a code. Wait a minute and try again.";
        this.patch({ phase: "needs-otp", error });
      }
    } catch (error) {
      if (generation === this.generation) this.fail("needs-otp", error);
    }
  }

  async submitOtp(code: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const digits = code.replace(/\s/g, "");
    if (!isValidOtp(digits)) {
      this.patch({ error: "Enter the code from the text message." });
      return;
    }
    const generation = this.generation;
    this.patch({ phase: "verifying", error: "" });
    try {
      const reply: ProvisioningReply = await submitOtp(this.deps.backend, session.address, session.cookie, digits);
      if (generation !== this.generation) return;
      if (reply.kind === "config") {
        await this.complete(reply.line);
      } else if (reply.kind === "otp-required") {
        // The router started a fresh session; codes from the old one won't work.
        this.adoptChallenge({ ...reply, address: session.address });
        this.patch({ error: "That code wasn't accepted, and the router sent a new one." });
      } else if (reply.kind === "rejected" && reply.status !== 200) {
        this.patch({ phase: "otp-sent", error: `${provisioningRefusal(reply)} Request a new code.` });
      } else {
        this.patch({ phase: "otp-sent", error: "That code wasn't accepted. Check it, or request a new one." });
      }
    } catch (error) {
      if (generation === this.generation) this.fail("otp-sent", error);
    }
  }

  /** The router answered a routine refresh with a challenge: a code is already on its way. */
  adoptChallenge(challenge: { cookie: string; sentTo: string; address: string }): void {
    this.session = { cookie: challenge.cookie, address: challenge.address };
    this.patch({ phase: "otp-sent", otpSentTo: challenge.sentTo, error: "" });
  }

  /**
   * A routine refresh found this device missing from the router's whitelist.
   * Nothing has been sent: the user decides whether to request a code. A code
   * step already in progress is left alone.
   */
  needsConfirmation(): void {
    const { phase } = this.deps.store.get().onboarding;
    if (phase === "otp-sent" || phase === "verifying" || phase === "requesting-otp") return;
    this.session = null;
    this.patch({ phase: "needs-otp", otpSentTo: "", error: "" });
  }

  reset(): void {
    this.generation++;
    this.identity = null;
    this.session = null;
    this.deps.store.update({ onboarding: INITIAL_ONBOARDING });
  }

  /** Back out of the code step without touching the router. */
  cancel(): void {
    this.generation++;
    this.session = null;
    this.patch({ phase: "idle", otpSentTo: "", error: "" });
  }

  private async complete(line: ProvisionedLine): Promise<void> {
    const identity = this.currentIdentity();
    if (!identity) return;
    const number = formatNumber(numberFromIdentity(line.publicIdentity));
    log.addSecret(numberFromIdentity(line.publicIdentity));
    log.addSecret(line.password);
    const saved = await this.deps.vault.set({ ...identity, number, onboarded: true });
    this.session = null;
    this.identity = null;
    this.deps.store.update({
      account: { deviceName: identity.deviceName, number },
      // From here the line finds the router on every attempt; a first-run
      // discovery result must not outlive that.
      onboarding: { discovery: { status: "idle" }, phase: "idle", otpSentTo: "", error: "" },
      ...(saved ? {} : { storage: "unsaved" as const }),
    });
    log.info("onboarding", "device authorised");
    this.deps.onAuthorised();
  }

  private currentIdentity(): ProvisioningIdentity | null {
    if (this.identity) return this.identity;
    const stored = this.deps.vault.get();
    return stored ? { deviceId: stored.deviceId, deviceName: stored.deviceName } : null;
  }

  private routerAddress(): string | null {
    const { onboarding, router } = this.deps.store.get();
    if (onboarding.discovery.status === "found") return onboarding.discovery.router.address;
    return router?.address ?? null;
  }

  private fail(phase: OnboardingState["phase"], error: unknown): void {
    log.warn("onboarding", error instanceof Error ? error.message : String(error));
    const message =
      error instanceof RouterHttpError ? routerFailure(error.code) : "Something went wrong on this step. Try again.";
    this.patch({ phase, error: message });
  }

  private patch(patch: Partial<OnboardingState>): void {
    const { store } = this.deps;
    store.update({ onboarding: { ...store.get().onboarding, ...patch } });
  }
}
