import { writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  systemPreferences,
} from "electron";
import { formatNumber } from "@shared/phone";
import {
  API_METHODS,
  type Api,
  type AudioDevices,
  DEFAULT_SETTINGS,
  type MainView,
  type Platform,
  type Settings,
} from "@shared/types";
import { setLaunchAtLogin } from "./autostart";
import type { Backend } from "./backend";
import { CallsController } from "./calls/controller";
import { buildDiagnostics } from "./diagnostics";
import { EngineProcess } from "./engine/process";
import { LineController } from "./line/controller";
import { SIGNED_OUT } from "./line/machine";
import { log } from "./logger";
import { INITIAL_ONBOARDING, OnboardingController } from "./onboarding";
import { dataPath, engineBinaryPath } from "./paths";
import { localAddressFor, systemDiscoveryDeps } from "./router/discovery";
import { routerRequest } from "./router/http";
import { readJson, writeJson } from "./store/files";
import { HistoryStore } from "./store/history";
import { StateStore } from "./store/state";
import { Vault } from "./store/vault";
import { AppTray } from "./tray";
import { Windows } from "./windows";

const demo = process.env.JIOJOIN_DEMO === "1";
const shotsDir = process.env.JIOJOIN_SHOTS ?? "";

app.setName("JioJoin");
// A fixed folder, so the app's data never shares one with anything else
// called JioJoin. Demo mode keeps its own so it can never touch a real sign-in.
app.setPath(
  "userData",
  demo
    ? (process.env.JIOJOIN_DEMO_DATA ?? join(app.getPath("appData"), "JioJoin Desktop Demo"))
    : join(app.getPath("appData"), "JioJoin Desktop"),
);

// The screenshot run must keep painting even when its window is behind others.
if (shotsDir) {
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(main);
}

async function main(): Promise<void> {
  log.setFile(dataPath("logs/app.log"));
  log.info("app", `starting ${app.getVersion()} on ${process.platform}${demo ? " (demo)" : ""}`);

  const settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(dataPath("settings.json"), {}) };
  nativeTheme.themeSource = settings.theme;

  // Demo mode must not create or read anything in the real keychain.
  const vault = demo ? Vault.inMemory() : await Vault.open(dataPath("account.bin"));
  if (!demo && (await vault.adoptImport(dataPath("import-device.json")))) {
    log.info("app", "imported a device id; onboarding will try it before asking for a code");
  }
  const stored = vault.get();
  if (stored) {
    log.addSecret(stored.deviceId);
    log.addSecret(stored.deviceName);
    log.addSecret(stored.number);
    log.addSecret(stored.number.replace(/\D/g, ""));
  }

  const windows = new Windows();
  const store = new StateStore({
    platform: process.platform as Platform,
    version: app.getVersion(),
    demo,
    defaultDeviceName: demo ? "Study Mac" : hostname().replace(/\.(local|lan|home)$/i, "").slice(0, 32),
    account: stored?.onboarded ? { deviceName: stored.deviceName, number: stored.number } : null,
    onboarding: INITIAL_ONBOARDING,
    line: SIGNED_OUT,
    router: null,
    call: null,
    missedCount: 0,
    settings,
    engine: { ready: false, version: "", codecs: [], error: "" },
    secureStorage: vault.secure || demo,
  });

  const history = new HistoryStore(dataPath("history.json"), (entries) => {
    windows.broadcast("history", entries);
    store.update({ missedCount: history.missedCount() });
  });
  store.update({ missedCount: history.missedCount() });

  const backend: Backend = demo
    ? (await import("./demo/backend")).createDemoBackend(stored?.deviceId)
    : {
        discovery: systemDiscoveryDeps,
        request: routerRequest,
        localAddressFor,
        engine: new EngineProcess(engineBinaryPath()),
        ensureMicrophone: async () => {
          if (process.platform !== "darwin") return true;
          if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
          return systemPreferences.askForMediaAccess("microphone");
        },
      };

  const onboarding = new OnboardingController({
    backend,
    store,
    vault,
    onAuthorised: () => line.dispatch({ type: "sign-in" }),
  });

  const calls = new CallsController({
    backend,
    store,
    history,
    homeDomain: () => (line.status === "registered" ? line.homeDomain : ""),
    onIncoming: (call) => {
      windows.showIncoming();
      if (Notification.isSupported() && !windows.mainVisibleAndFocused) {
        const notification = new Notification({
          title: "Incoming call",
          body: formatNumber(call.number) || call.name || "Unknown caller",
          silent: true,
        });
        notification.on("click", () => windows.showMain());
        notification.show();
      }
    },
    onCallOver: (call) => {
      windows.hideIncoming();
      line.callEnded();
      if (call.direction === "incoming" && !call.answeredAt && call.endReason === "Missed call") {
        if (Notification.isSupported() && !windows.mainVisibleAndFocused) {
          const notification = new Notification({
            title: "Missed call",
            body: formatNumber(call.number) || "Unknown caller",
          });
          notification.on("click", () => windows.showMain("recents"));
          notification.show();
        }
      }
    },
  });

  const line = new LineController({
    backend,
    store,
    vault,
    hasActiveCall: () => calls.active,
    onOtpChallenge: (challenge) => onboarding.adoptChallenge(challenge),
  });

  backend.engine.onEvent = (event) => {
    if (event.event === "level") {
      windows.sendToMain("level", { mic: event.mic, speaker: event.speaker });
      return;
    }
    line.handleEngineEvent(event);
    calls.handleEngineEvent(event);
  };
  backend.engine.onCrash = () => {
    calls.handleEngineStopped();
    line.handleEngineCrash();
  };

  const quit = () => {
    windows.quitting = true;
    app.quit();
  };

  const tray = new AppTray({
    open: () => windows.showMain(),
    openRecents: () => windows.showMain("recents"),
    reconnect: () => line.dispatch({ type: "connect" }),
    disconnect: () => line.dispatch({ type: "disconnect" }),
    quit,
  });
  store.subscribe((state) => {
    windows.broadcast("state", state);
    tray.update(state);
    // An answered or finished call no longer needs the popup.
    if (state.call?.state !== "incoming") windows.hideIncoming();
  });
  tray.update(store.get());

  const saveSettings = (patch: Partial<Settings>) => {
    const next = { ...store.get().settings, ...patch };
    writeJson(dataPath("settings.json"), next);
    store.update({ settings: next });
  };

  const api: Api = {
    getState: async () => store.get(),

    discover: () => onboarding.discover(),
    checkDevice: (name) => onboarding.checkDevice(String(name).slice(0, 64)),
    requestOtp: () => onboarding.requestOtp(),
    submitOtp: (code) => onboarding.submitOtp(String(code).slice(0, 16)),
    cancelOnboarding: async () => onboarding.cancel(),

    reconnect: async () => line.dispatch({ type: "connect" }),
    disconnect: async () => line.dispatch({ type: "disconnect" }),

    dial: (number) => calls.dial(String(number).slice(0, 64)),
    answer: () => calls.answer(),
    hangup: () => calls.hangup(),
    setMuted: (muted) => calls.setMuted(muted === true),
    setHold: (held) => calls.setHold(held === true),
    sendDtmf: (digits) => calls.sendDtmf(String(digits)),
    dismissCall: async () => calls.dismiss(),

    listHistory: async () => history.list(),
    deleteHistory: async (id) => history.remove(String(id)),
    clearHistory: async () => history.clear(),
    markMissedSeen: async () => history.markMissedSeen(),

    listAudioDevices: async () => {
      const { inputDevice, outputDevice } = store.get().settings;
      try {
        if (!backend.engine.running) await startIdleEngine();
        const reply = await backend.engine.request<{
          devices: { name: string; inputs: number; outputs: number }[];
        }>("devices");
        return {
          devices: reply.devices.map((d) => ({ name: d.name, input: d.inputs > 0, output: d.outputs > 0 })),
          input: inputDevice,
          output: outputDevice,
        } satisfies AudioDevices;
      } catch {
        return { devices: [], input: inputDevice, output: outputDevice };
      }
    },
    setAudioDevices: async (devices) => {
      const patch: Partial<Settings> = {};
      if (typeof devices?.input === "string") patch.inputDevice = devices.input;
      if (typeof devices?.output === "string") patch.outputDevice = devices.output;
      saveSettings(patch);
      return engineAction("setDevices", { input: patch.inputDevice, output: patch.outputDevice });
    },
    setMeter: async (on) => {
      if (on === true && !(await backend.ensureMicrophone())) {
        return { ok: false, error: "Microphone access is turned off for JioJoin in your system's privacy settings." };
      }
      if (on !== true && !backend.engine.running) return { ok: true };
      return engineAction("meter", { on: on === true });
    },
    playTestTone: () => engineAction("testTone"),

    updateSettings: async (patch) => {
      const clean: Partial<Settings> = {};
      if (typeof patch?.launchAtLogin === "boolean") clean.launchAtLogin = patch.launchAtLogin;
      if (typeof patch?.startHidden === "boolean") clean.startHidden = patch.startHidden;
      if (typeof patch?.routerOverride === "string") clean.routerOverride = patch.routerOverride.trim().slice(0, 253);
      if (patch?.theme === "system" || patch?.theme === "light" || patch?.theme === "dark") clean.theme = patch.theme;
      saveSettings(clean);
      if (clean.launchAtLogin !== undefined) setLaunchAtLogin(clean.launchAtLogin);
      if (clean.theme) nativeTheme.themeSource = clean.theme;
      if (clean.routerOverride !== undefined && store.get().account) line.dispatch({ type: "connect" });
    },
    signOut: async () => {
      await calls.hangup();
      line.dispatch({ type: "sign-out" });
      vault.clear();
      history.clear();
      onboarding.reset();
      store.update({ account: null, router: null });
      log.info("app", "signed out; credentials wiped");
    },
    exportDiagnostics: async () => {
      const window = windows.mainWindow;
      const options = {
        title: "Export diagnostics",
        defaultPath: join(app.getPath("downloads"), `jiojoin-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`),
        filters: [{ name: "Text", extensions: ["txt"] }],
      };
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { ok: false };
      try {
        writeFileSync(result.filePath, buildDiagnostics(store.get(), history.list(), log));
        return { ok: true, path: result.filePath };
      } catch {
        return { ok: false, error: "Couldn't write the file there." };
      }
    },
    showMainWindow: async (view) => windows.showMain(isView(view) ? view : undefined),
  };

  /** Settings can list devices and run the meter before the line is up. */
  async function startIdleEngine(): Promise<void> {
    const hello = await backend.engine.start();
    store.update({ engine: { ready: true, version: hello.engine, codecs: hello.codecs, error: "" } });
    const { inputDevice, outputDevice } = store.get().settings;
    await backend.engine.request("setDevices", { input: inputDevice, output: outputDevice }).catch(() => {});
  }

  async function engineAction(cmd: string, params: Record<string, unknown> = {}) {
    try {
      if (!backend.engine.running) await startIdleEngine();
      await backend.engine.request(cmd, params);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The calling engine isn't available." };
    }
  }

  for (const method of API_METHODS) {
    ipcMain.handle(`api:${method}`, (event, ...args: unknown[]) => {
      // Only our own pages may drive the app.
      const url = event.senderFrame?.url ?? "";
      const trusted = url.startsWith("file://") || (!app.isPackaged && url.startsWith("http://localhost:"));
      if (!trusted) throw new Error("untrusted sender");
      return (api[method] as (...a: unknown[]) => unknown)(...args);
    });
  }

  Menu.setApplicationMenu(buildMenu(windows, quit));

  app.on("second-instance", () => windows.showMain());
  app.on("activate", () => windows.showMain());
  app.on("before-quit", () => {
    windows.quitting = true;
  });
  // The app lives in the tray; closing every window must not end it.
  app.on("window-all-closed", () => {});
  let engineStopped = false;
  app.on("will-quit", (event) => {
    if (engineStopped) return;
    event.preventDefault();
    engineStopped = true;
    tray.destroy();
    // Give the engine a moment to remove its registration from the router.
    // Quit on a later tick: Electron ignores app.quit() while it is still
    // unwinding the will-quit it was just told to cancel.
    void backend.engine.stop().finally(() => setTimeout(() => app.quit(), 0));
  });

  watchNetwork(() => line.networkChanged());

  // Setup always needs its window; otherwise honour "start in the tray".
  const hidden = store.get().account !== null && settings.startHidden && !shotsDir;
  if (hidden) windows.createHidden();
  else windows.showMain();

  if (store.get().account) line.dispatch({ type: "sign-in" });
  else void onboarding.discover();

  // Development aid: save one capture of the main window, then quit.
  const captureTo = app.isPackaged ? "" : (process.env.JIOJOIN_CAPTURE ?? "");
  if (captureTo) {
    setTimeout(async () => {
      const image = await windows.mainWindow?.webContents.capturePage();
      if (image) writeFileSync(captureTo, image.toPNG());
      quit();
    }, 6000);
  }

  if (demo && shotsDir) {
    const { runScreenshots } = await import("./demo/shots");
    // A stuck scenario must not leave the demo app running.
    const watchdog = setTimeout(() => app.exit(2), 150_000);
    try {
      await runScreenshots({ dir: shotsDir, windows, api, engine: backend.engine, history, store });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    clearTimeout(watchdog);
    quit();
  }
}

function isView(value: unknown): value is MainView {
  return value === "keypad" || value === "recents" || value === "settings";
}

/** Watches for the things that silently break a registration: a new address, or waking from sleep. */
function watchNetwork(onChange: () => void): void {
  const snapshot = () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal && address.family === "IPv4")
      .map((address) => address?.address)
      .sort()
      .join(",");

  let last = snapshot();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, 2000);
  };
  setInterval(() => {
    const now = snapshot();
    if (now === last) return;
    last = now;
    log.info("network", "addresses changed");
    changed();
  }, 5000).unref();
  powerMonitor.on("resume", () => {
    log.info("network", "woke from sleep");
    changed();
  });
}

function buildMenu(windows: Windows, quit: () => void): Menu {
  const mac = process.platform === "darwin";
  const go = (view: MainView) => () => windows.showMain(view);
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: "JioJoin",
            submenu: [
              { role: "about" as const, label: "About JioJoin" },
              { type: "separator" as const },
              { label: "Settings…", accelerator: "Cmd+,", click: go("settings") },
              { type: "separator" as const },
              { role: "hide" as const, label: "Hide JioJoin" },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { label: "Quit JioJoin", accelerator: "Cmd+Q", click: quit },
            ],
          },
        ]
      : [
          {
            label: "File",
            submenu: [
              { label: "Settings", accelerator: "Ctrl+,", click: go("settings") },
              { type: "separator" as const },
              { label: "Quit", accelerator: "Ctrl+Q", click: quit },
            ],
          },
        ]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Keypad", accelerator: "CmdOrCtrl+1", click: go("keypad") },
        { label: "Recents", accelerator: "CmdOrCtrl+2", click: go("recents") },
        { label: "Settings", accelerator: "CmdOrCtrl+3", click: go("settings") },
        ...(app.isPackaged
          ? []
          : [{ type: "separator" as const }, { role: "reload" as const }, { role: "toggleDevTools" as const }]),
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
