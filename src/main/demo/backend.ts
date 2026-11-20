import type { Backend } from "../backend";
import type { Engine } from "../engine/process";
import type { EngineEvent, EngineHello } from "../engine/protocol";
import type { RouterResponse } from "../router/http";

/**
 * A stand-in for the router and the engine, used by `bun run demo` and the
 * screenshot script. It never opens a socket, so the UI can be exercised
 * without a Jio line. Every identity here is fictional.
 */

const DEMO_ROUTER = "192.168.29.1";
const DEMO_OTP = "246810";
const DEMO_UNAUTHORISED = `<wap-provisioningdoc version="1.1"><characteristic type="VERS"><parm name="version" value="-2"/><parm name="validity" value="-2"/></characteristic></wap-provisioningdoc>`;
const DEMO_XML = `<wap-provisioningdoc version="1.1"><characteristic type="application">
<characteristic type="appauth"><parm name="realm" value="demo.wln.ims.example"/>
<parm name="username" value="912255500142@demo.wln.ims.example"/><parm name="userpwd" value="demo-only"/></characteristic>
<characteristic type="lbo_p-cscf_address"><parm name="address" value="jiofiber.local.html:5068"/></characteristic>
<characteristic type="other"><parm name="uuid_value" value="00000000-0000-1000-8000-0A0B0C0D0E0F"/></characteristic>
<parm name="home_network_domain_name" value="demo.wln.ims.example"/>
<characteristic type="public_user_identity_list"><parm name="public_user_identity" value="sip:+912255500142@demo.wln.ims.example"/></characteristic>
<characteristic type="rjil"><parm name="psoltid" value="+912255"/></characteristic>
</characteristic></wap-provisioningdoc>`;

type CallEvent = Extract<EngineEvent, { event: "call" }>;

export class DemoEngine implements Engine {
  running = false;
  onEvent: (event: EngineEvent) => void = () => {};
  onCrash: () => void = () => {};
  onStop: () => void = () => {};
  private timers: ReturnType<typeof setTimeout>[] = [];
  private meter: ReturnType<typeof setInterval> | null = null;
  private call: CallEvent | null = null;
  private input = "";
  private output = "";

  async start(): Promise<EngineHello> {
    await this.stop();
    this.running = true;
    return {
      engine: "demo",
      protocol: 1,
      pjsip: "demo",
      tls: true,
      codecs: ["AMR-WB/16000/1", "AMR/8000/1", "PCMU/8000/1"],
    };
  }

  async stop(): Promise<void> {
    if (this.running) this.onStop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    this.call = null;
    this.running = false;
  }

  async request<T = Record<string, unknown>>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    const done = (value: Record<string, unknown> = {}) => value as T;
    switch (cmd) {
      case "register":
        this.later(500, () =>
          this.onEvent({ event: "reg", state: "registered", code: 200, reason: "OK", expires: 3600 }),
        );
        return done();
      case "dial": {
        const number = String(params.number ?? "");
        this.emitCall({ direction: "out", state: "calling", number });
        this.later(700, () => this.emitCall({ state: "ringing", code: 180 }));
        if (number.endsWith("0000")) {
          this.later(2200, () => this.emitCall({ state: "ended", code: 486, reason: "Busy Here" }));
        } else {
          this.later(2600, () => this.emitCall({ state: "active", code: 200, codec: "AMR-WB" }));
        }
        return done({ callId: 0 });
      }
      case "answer":
        this.emitCall({ state: "active", code: 200, codec: "AMR-WB" });
        return done();
      case "hangup":
        this.clearTimers();
        this.emitCall({ state: "ended", code: 200, reason: "Normal call clearing" });
        return done();
      case "hold":
        this.emitCall({ held: params.on === true });
        return done();
      case "mute":
        if (this.call) this.emitCall({ muted: params.on === true });
        return done();
      case "devices":
        return done({
          devices: [
            { name: "MacBook Pro Microphone", inputs: 1, outputs: 0 },
            { name: "MacBook Pro Speakers", inputs: 0, outputs: 2 },
            { name: "USB Headset", inputs: 1, outputs: 2 },
          ],
          input: this.input,
          output: this.output,
        });
      case "setDevices":
        if (typeof params.input === "string") this.input = params.input;
        if (typeof params.output === "string") this.output = params.output;
        return done();
      case "meter":
        if (this.meter) clearInterval(this.meter);
        this.meter = null;
        if (params.on === true) {
          let phase = 0;
          this.meter = setInterval(() => {
            phase += 0.35;
            const mic = Math.round(70 + 60 * Math.abs(Math.sin(phase)) + 30 * Math.sin(phase * 2.7));
            this.onEvent({ event: "level", mic: Math.max(0, mic), speaker: 0 });
          }, 90);
        }
        return done();
      default:
        return done();
    }
  }

  /** Makes the demo line ring. */
  simulateIncoming(number: string, name = ""): void {
    if (this.call) return;
    this.emitCall({ direction: "in", state: "incoming", number, name });
  }

  private emitCall(patch: Partial<CallEvent>): void {
    const base: CallEvent = this.call ?? {
      event: "call",
      callId: 0,
      direction: "out",
      state: "calling",
      number: "",
      name: "",
      code: 0,
      reason: "",
      held: false,
      remoteHeld: false,
      muted: false,
    };
    const next = { ...base, ...patch };
    this.call = next.state === "ended" ? null : next;
    this.onEvent(next);
  }

  private later(ms: number, run: () => void): void {
    this.timers.push(setTimeout(run, ms));
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

export function createDemoBackend(knownDeviceId?: string): Backend & { engine: DemoEngine } {
  // A device authorised in an earlier demo session stays authorised.
  const authorised = new Set<string>(knownDeviceId ? [knownDeviceId] : []);
  const pending = new Map<string, string>();
  const reply = (status: number, body = "", headers: RouterResponse["headers"] = {}): RouterResponse => ({
    status,
    headers,
    body,
  });

  return {
    discovery: {
      resolve4: async () => [DEMO_ROUTER],
      gateway4: async () => DEMO_ROUTER,
      probe: async () => {
        await delay(600);
        return { ok: true, server: "JIDU6911/JUICEJFV-1.5.5" };
      },
    },
    async request({ path, cookie }) {
      await delay(500);
      const query = new URL(`https://demo${path}`).searchParams;
      const otp = query.get("OTP");
      if (otp !== null) {
        const device = cookie ? pending.get(cookie) : undefined;
        if (!device || otp !== DEMO_OTP) return reply(403);
        authorised.add(device);
        return reply(200, DEMO_XML);
      }
      const device = query.get("mac_address") ?? "";
      if (authorised.has(device)) return reply(200, DEMO_XML);
      // Like JUICE: an unknown device's plain request gets a document with no account.
      if (query.get("op_type") !== "add") return reply(200, DEMO_UNAUTHORISED);
      const session = `DemoCookie=${device}`;
      pending.set(session, device);
      return reply(200, "", { "set-cookie": [`${session}; Path=/`], "x-amn": "+91********42" });
    },
    localAddressFor: async () => "192.168.29.40",
    engine: new DemoEngine(),
    ensureMicrophone: async () => true,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
