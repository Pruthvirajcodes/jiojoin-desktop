export type Platform = "darwin" | "win32" | "linux";

export type RouterSource = "dns" | "gateway" | "manual";

export interface RouterInfo {
  /** IPv4 address the app talks to. */
  address: string;
  source: RouterSource;
  /** `Server` header of the voice gateway, for example "JIDU6911/JUICEJFV-1.5.5". */
  server: string;
}

export type DiscoveryState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "found"; router: RouterInfo }
  | { status: "not-found"; reason: string; tried: string[] };

export type OnboardingPhase =
  | "idle"
  | "checking"
  | "needs-otp"
  | "requesting-otp"
  | "otp-sent"
  | "verifying";

export interface OnboardingState {
  discovery: DiscoveryState;
  phase: OnboardingPhase;
  /** Masked mobile number the router texted, when it reports one. */
  otpSentTo: string;
  error: string;
  /** Shown above setup: why it is running again, when the app knows. */
  notice?: string;
}

export type LineStatus =
  | "signed-out"
  | "offline"
  | "connecting"
  | "registered"
  | "retrying"
  | "needs-otp";

export type LinePhase = "finding-router" | "refreshing" | "registering";

export interface LineState {
  status: LineStatus;
  phase?: LinePhase;
  /** Plain-language reason for the current status, when there is one. */
  detail: string;
  /** Epoch milliseconds of the next automatic attempt while retrying. */
  retryAt?: number;
  attempt: number;
}

export type CallDirection = "incoming" | "outgoing";
export type CallState = "dialing" | "ringing" | "incoming" | "connecting" | "active" | "ended";

export interface CallInfo {
  id: string;
  direction: CallDirection;
  /** Canonical number, or "" when the caller withheld it. */
  number: string;
  name: string;
  state: CallState;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  muted: boolean;
  held: boolean;
  remoteHeld: boolean;
  codec: string;
  /** Plain-language outcome once the call has ended. */
  endReason: string;
  failed: boolean;
  /** Why the last action on this call (such as Answer) didn't work. */
  notice?: string;
}

export type HistoryKind = "incoming" | "outgoing" | "missed" | "failed";

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  number: string;
  name: string;
  at: number;
  durationSec: number;
  reason: string;
  seen: boolean;
}

export type ThemeSetting = "system" | "light" | "dark";

export interface Settings {
  launchAtLogin: boolean;
  startHidden: boolean;
  /** Router host or IP typed by the user; "" means find it automatically. */
  routerOverride: string;
  /** Device names; "" means the system default. */
  inputDevice: string;
  outputDevice: string;
  theme: ThemeSetting;
}

export const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: false,
  startHidden: false,
  routerOverride: "",
  inputDevice: "",
  outputDevice: "",
  theme: "system",
};

export interface Account {
  deviceName: string;
  /** The line's own number in display form. */
  number: string;
}

export interface EngineStatus {
  ready: boolean;
  version: string;
  codecs: string[];
  error: string;
}

export interface AppState {
  platform: Platform;
  version: string;
  demo: boolean;
  /** Suggested name for this device during setup. */
  defaultDeviceName: string;
  account: Account | null;
  onboarding: OnboardingState;
  line: LineState;
  router: RouterInfo | null;
  call: CallInfo | null;
  missedCount: number;
  settings: Settings;
  engine: EngineStatus;
  /**
   * Where the sign-in is kept: the OS keychain, a file only this user can
   * read (no usable keychain), or nowhere because saving failed.
   */
  storage: SignInStorage;
}

export type SignInStorage = "keychain" | "file" | "unsaved";

/** What the setup screen should do after checking whether the router knows this device. */
export type CheckOutcome = "done" | "authorise" | "retry";

export interface AudioDevice {
  name: string;
  input: boolean;
  output: boolean;
}

export interface AudioDevices {
  devices: AudioDevice[];
  input: string;
  output: string;
}

export interface AudioLevel {
  mic: number;
  speaker: number;
}

export type MainView = "keypad" | "recents" | "settings";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Everything the renderer may ask the main process to do. */
export interface Api {
  getState(): Promise<AppState>;

  discover(): Promise<void>;
  checkDevice(deviceName: string): Promise<CheckOutcome>;
  requestOtp(): Promise<void>;
  submitOtp(code: string): Promise<void>;
  cancelOnboarding(): Promise<void>;

  reconnect(): Promise<void>;
  disconnect(): Promise<void>;

  dial(number: string): Promise<ActionResult>;
  answer(): Promise<ActionResult>;
  hangup(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setHold(held: boolean): Promise<void>;
  sendDtmf(digits: string): Promise<void>;
  dismissCall(): Promise<void>;

  listHistory(): Promise<HistoryEntry[]>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  markMissedSeen(): Promise<void>;

  listAudioDevices(): Promise<AudioDevices>;
  setAudioDevices(devices: { input?: string; output?: string }): Promise<ActionResult>;
  setMeter(on: boolean): Promise<ActionResult>;
  playTestTone(): Promise<ActionResult>;

  updateSettings(patch: Partial<Settings>): Promise<void>;
  signOut(): Promise<void>;
  exportDiagnostics(): Promise<ActionResult & { path?: string }>;
  showMainWindow(view?: MainView): Promise<void>;
}

export const API_METHODS = [
  "getState",
  "discover",
  "checkDevice",
  "requestOtp",
  "submitOtp",
  "cancelOnboarding",
  "reconnect",
  "disconnect",
  "dial",
  "answer",
  "hangup",
  "setMuted",
  "setHold",
  "sendDtmf",
  "dismissCall",
  "listHistory",
  "deleteHistory",
  "clearHistory",
  "markMissedSeen",
  "listAudioDevices",
  "setAudioDevices",
  "setMeter",
  "playTestTone",
  "updateSettings",
  "signOut",
  "exportDiagnostics",
  "showMainWindow",
] as const satisfies readonly (keyof Api)[];

/** Push events from main to a renderer. */
export interface ApiEvents {
  state: AppState;
  history: HistoryEntry[];
  level: AudioLevel;
  navigate: MainView;
}

export type Bridge = Api & {
  on<K extends keyof ApiEvents>(event: K, listener: (payload: ApiEvents[K]) => void): () => void;
};
