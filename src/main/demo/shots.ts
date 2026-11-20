import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserWindow, nativeTheme } from "electron";
import type { Api, AppState } from "@shared/types";
import type { Engine } from "../engine/process";
import type { HistoryStore } from "../store/history";
import type { StateStore } from "../store/state";
import type { Windows } from "../windows";
import type { DemoEngine } from "./backend";

/**
 * Drives the demo app through every main screen and saves a light and a dark
 * capture of each. Run with `bun run screenshots`.
 */
export async function runScreenshots(context: {
  dir: string;
  windows: Windows;
  api: Api;
  engine: Engine;
  history: HistoryStore;
  store: StateStore;
}): Promise<void> {
  const { dir, windows, api, history, store } = context;
  const engine = context.engine as DemoEngine;
  mkdirSync(dir, { recursive: true });

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const until = async (test: (state: AppState) => boolean, label: string) => {
    for (let waited = 0; waited < 15_000; waited += 50) {
      if (test(store.get())) return;
      await delay(50);
    }
    throw new Error(`screenshots: timed out waiting for ${label}`);
  };
  const main = (): BrowserWindow => {
    const window = windows.mainWindow;
    if (!window) throw new Error("screenshots: no main window");
    return window;
  };
  const js = (code: string) => main().webContents.executeJavaScript(code, true);
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const shot = async (name: string, window: BrowserWindow = main()) => {
    console.log(`screenshots: ${name}`);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await delay(400);
      // Force a fresh frame: a window in the background may not have painted.
      window.webContents.invalidate();
      await delay(120);
      const image = await window.webContents.capturePage();
      writeFileSync(join(dir, `${name}-${theme}.png`), image.toPNG());
    }
  };

  await delay(1200);
  main().setSize(820, 600);

  await until((s) => s.onboarding.discovery.status === "found", "router");
  await shot("01-setup-router-found");

  await click('[data-shot="continue"]');
  await delay(200);
  await shot("02-setup-name-device");

  await click('[data-shot="continue"]');
  await until((s) => s.onboarding.phase === "needs-otp", "otp prompt");
  await delay(200);
  await shot("03-setup-request-otp");

  await api.requestOtp();
  await until((s) => s.onboarding.phase === "otp-sent", "otp sent");
  await delay(200);
  await js('document.querySelector("#otp")?.focus()');
  await main().webContents.insertText("246810");
  await shot("04-setup-enter-otp");

  await api.submitOtp("246810");
  await until((s) => s.account !== null, "account");
  await delay(200);
  await shot("05-setup-done");

  await click('[data-shot="continue"]');
  await until((s) => s.line.status === "registered", "registration");
  await delay(300);
  await shot("06-keypad");

  await js('document.querySelector("[aria-label=\\"Number to call\\"]")?.focus()');
  await main().webContents.insertText("9876543210");
  await delay(150);
  await shot("07-keypad-number");

  const minute = 60_000;
  const now = Date.now();
  const seed = [
    { kind: "failed", number: "+912240001234", at: now - 26 * 60 * minute, durationSec: 0, reason: "Busy" },
    { kind: "incoming", number: "+918012345678", at: now - 25 * 60 * minute, durationSec: 312, reason: "" },
    { kind: "missed", number: "+919820012345", at: now - 5 * 60 * minute, durationSec: 0, reason: "Missed call" },
    { kind: "outgoing", number: "+912266554433", at: now - 3 * 60 * minute, durationSec: 47, reason: "" },
    { kind: "incoming", number: "+919876543210", at: now - 95 * minute, durationSec: 734, reason: "" },
    { kind: "missed", number: "", at: now - 40 * minute, durationSec: 0, reason: "Missed call" },
  ] as const;
  for (const entry of seed) history.add({ ...entry, name: "" });

  await api.dial("9876543210");
  await until((s) => s.call?.state === "ringing", "ringing");
  await shot("08-call-ringing");
  await until((s) => s.call?.state === "active", "active call");
  await delay(1600);
  await shot("09-call-active");
  await click('button[aria-label="Keypad"]');
  await delay(150);
  await click('[aria-label="Keypad"] [aria-label="1"]');
  await click('[aria-label="Keypad"] [aria-label="4"]');
  await delay(100);
  await shot("10-call-keypad");
  await api.hangup();
  await api.dismissCall();
  await until((s) => s.call === null, "call cleared");

  engine.simulateIncoming("09123456780");
  await until((s) => s.call?.state === "incoming", "incoming call");
  await delay(900);
  await shot("11-call-incoming");
  const popup = windows.incomingWindow;
  if (popup) await shot("12-incoming-popup", popup);
  await api.hangup();
  await api.dismissCall();
  await until((s) => s.call === null, "call cleared");

  await api.dial("02240000000");
  await until((s) => s.call?.state === "ended", "failed call");
  await delay(150);
  await shot("13-call-failed");
  await api.dismissCall();

  windows.sendToMain("navigate", "recents");
  await delay(300);
  await shot("14-recents");

  windows.sendToMain("navigate", "settings");
  await delay(600);
  await shot("15-settings");
  await js('document.querySelector("main .overflow-y-auto")?.scrollTo(0, 100000)');
  await delay(200);
  await shot("16-settings-more");

  const registered = store.get().line;
  store.update({
    line: { status: "retrying", detail: "The router didn't answer in time.", attempt: 2, retryAt: Date.now() + 20_000 },
  });
  windows.sendToMain("navigate", "keypad");
  await delay(300);
  await shot("17-keypad-not-connected");
  store.update({ line: registered });

  history.clear();
  windows.sendToMain("navigate", "recents");
  await delay(300);
  await shot("18-recents-empty");

  store.update({
    account: null,
    onboarding: {
      discovery: {
        status: "not-found",
        reason: "The router's calling service isn't reachable from this network.",
        tried: ["192.168.1.1"],
      },
      phase: "idle",
      otpSentTo: "",
      error: "",
    },
  });
  await delay(400);
  await shot("19-setup-router-not-found");
}
