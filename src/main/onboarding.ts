import { formatNumber } from "@shared/phone";
import type { OnboardingState } from "@shared/types";
import { type Backend, enrolDevice, fetchCredentials, submitOtp } from "./backend";
import { log } from "./logger";
import { discoverRouter } from "./router/discovery";
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

const UNREACHABLE = "Couldn't reach the router. Check that you're on your home network and try again.";

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

  /** Asks whether the router already knows this device. Cannot trigger an OTP. */
  async checkDevice(deviceName: string): Promise<void> {
    const address = this.routerAddress();
    if (!address) return;
    const existing = this.deps.vault.get();
    this.identity = {
      deviceId: existing?.deviceId ?? this.identity?.deviceId ?? generateDeviceId(),
      deviceName: deviceName.trim() || "Desktop",
    };
    log.addSecret(this.identity.deviceId);
    this.patch({ phase: "checking", error: "" });
    try {
      const reply = await fetchCredentials(this.deps.backend, address, this.identity, false);
      if (reply.kind === "config") this.complete(reply.line);
      else if (reply.kind === "otp-required") this.adoptChallenge({ ...reply, address });
      else this.patch({ phase: "needs-otp" });
    } catch (error) {
      this.fail("idle", error);
    }
  }

  /** The one action that makes the router text a code to the line's owner. */
  async requestOtp(): Promise<void> {
    const address = this.routerAddress();
    const identity = this.currentIdentity();
    if (!address || !identity) return;
    this.patch({ phase: "requesting-otp", error: "" });
    try {
      const reply = await enrolDevice(this.deps.backend, address, identity);
      if (reply.kind === "config") this.complete(reply.line);
      else if (reply.kind === "otp-required") this.adoptChallenge({ ...reply, address });
      else {
        log.warn("onboarding", `enrol rejected: ${reply.reason}`);
        this.patch({ phase: "needs-otp", error: "The router didn't send a code. Wait a minute and try again." });
      }
    } catch (error) {
      this.fail("needs-otp", error);
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
    this.patch({ phase: "verifying", error: "" });
    try {
      const reply: ProvisioningReply = await submitOtp(this.deps.backend, session.address, session.cookie, digits);
      if (reply.kind === "config") this.complete(reply.line);
      else {
        this.patch({ phase: "otp-sent", error: "That code wasn't accepted. Check it, or request a new one." });
      }
    } catch (error) {
      this.fail("otp-sent", error);
    }
  }

  /** The router answered a routine refresh with a challenge: a code is already on its way. */
  adoptChallenge(challenge: { cookie: string; sentTo: string; address: string }): void {
    this.session = { cookie: challenge.cookie, address: challenge.address };
    this.patch({ phase: "otp-sent", otpSentTo: challenge.sentTo, error: "" });
  }

  reset(): void {
    this.identity = null;
    this.session = null;
    this.deps.store.update({ onboarding: INITIAL_ONBOARDING });
  }

  /** Back out of the code step without touching the router. */
  cancel(): void {
    this.session = null;
    this.patch({ phase: "idle", otpSentTo: "", error: "" });
  }

  private complete(line: ProvisionedLine): void {
    const identity = this.currentIdentity();
    if (!identity) return;
    const number = formatNumber(numberFromIdentity(line.publicIdentity));
    log.addSecret(numberFromIdentity(line.publicIdentity));
    log.addSecret(line.password);
    this.deps.vault.set({ ...identity, number, onboarded: true });
    this.session = null;
    this.identity = null;
    this.deps.store.update({
      account: { deviceName: identity.deviceName, number },
      onboarding: { ...this.deps.store.get().onboarding, phase: "idle", otpSentTo: "", error: "" },
    });
    log.info("onboarding", "device authorised");
    this.deps.onAuthorised();
  }

  private currentIdentity(): ProvisioningIdentity | null {
    const stored = this.deps.vault.get();
    if (this.identity) return this.identity;
    return stored ? { deviceId: stored.deviceId, deviceName: stored.deviceName } : null;
  }

  private routerAddress(): string | null {
    const { onboarding, router } = this.deps.store.get();
    if (onboarding.discovery.status === "found") return onboarding.discovery.router.address;
    return router?.address ?? null;
  }

  private fail(phase: OnboardingState["phase"], error: unknown): void {
    log.warn("onboarding", error instanceof Error ? error.message : String(error));
    this.patch({ phase, error: UNREACHABLE });
  }

  private patch(patch: Partial<OnboardingState>): void {
    const { store } = this.deps;
    store.update({ onboarding: { ...store.get().onboarding, ...patch } });
  }
}
