import { join } from "node:path";
import { BrowserWindow, app, nativeTheme, screen, shell } from "electron";
import type { ApiEvents, MainView } from "@shared/types";
import { assetPath } from "./paths";

const INCOMING_SIZE = { width: 380, height: 132 };

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff";
}

function load(window: BrowserWindow, hash: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void window.loadURL(`${devUrl}#${hash}`);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash });
}

function harden(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}

const webPreferences = {
  preload: join(import.meta.dirname, "../preload/index.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
};

/** Owns the main window and the incoming-call popup. */
export class Windows {
  private main: BrowserWindow | null = null;
  private incoming: BrowserWindow | null = null;
  /** Set once the app is really quitting, so close stops meaning "hide". */
  quitting = false;

  showMain(view?: MainView): void {
    const window = this.main ?? this.createMain();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (view) this.sendToMain("navigate", view);
  }

  get mainWindow(): BrowserWindow | null {
    return this.main;
  }

  get incomingWindow(): BrowserWindow | null {
    return this.incoming;
  }

  get mainVisibleAndFocused(): boolean {
    return this.main !== null && this.main.isVisible() && this.main.isFocused();
  }

  broadcast<K extends keyof ApiEvents>(event: K, payload: ApiEvents[K]): void {
    for (const window of [this.main, this.incoming]) {
      if (window && !window.isDestroyed()) window.webContents.send(`event:${event}`, payload);
    }
  }

  sendToMain<K extends keyof ApiEvents>(event: K, payload: ApiEvents[K]): void {
    if (this.main && !this.main.isDestroyed()) this.main.webContents.send(`event:${event}`, payload);
  }

  /** A small always-on-top card, so a call is answerable whatever is in front. */
  showIncoming(): void {
    if (this.incoming) return;
    const { workArea } = screen.getPrimaryDisplay();
    const window = new BrowserWindow({
      ...INCOMING_SIZE,
      x: workArea.x + workArea.width - INCOMING_SIZE.width - 16,
      y: workArea.y + 16,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: true,
      hasShadow: true,
      title: "Incoming call",
      webPreferences,
    });
    this.incoming = window;
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    harden(window);
    window.once("ready-to-show", () => window.showInactive());
    window.on("closed", () => {
      if (this.incoming === window) this.incoming = null;
    });
    load(window, "incoming");
  }

  hideIncoming(): void {
    this.incoming?.destroy();
    this.incoming = null;
  }

  private createMain(): BrowserWindow {
    const mac = process.platform === "darwin";
    const window = new BrowserWindow({
      width: 820,
      height: 600,
      minWidth: 700,
      minHeight: 540,
      show: false,
      title: "JioJoin",
      backgroundColor: backgroundColor(),
      autoHideMenuBar: true,
      icon: process.platform === "linux" ? assetPath("icon.png") : undefined,
      ...(mac
        ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } }
        : {}),
      ...(process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: { color: "#00000000", symbolColor: titleSymbolColor(), height: 40 },
          }
        : {}),
      webPreferences,
    });
    this.main = window;
    harden(window);

    window.once("ready-to-show", () => {
      if (!this.startHidden) window.show();
      this.startHidden = false;
    });
    // Closing the window leaves the app in the tray so the line keeps ringing.
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on("closed", () => {
      if (this.main === window) this.main = null;
    });
    nativeTheme.on("updated", () => {
      if (window.isDestroyed()) return;
      window.setBackgroundColor(backgroundColor());
      if (process.platform === "win32") {
        window.setTitleBarOverlay({ color: "#00000000", symbolColor: titleSymbolColor() });
      }
    });
    load(window, "main");
    return window;
  }

  private startHidden = false;

  /** Creates the main window without showing it, for a start in the tray. */
  createHidden(): void {
    if (this.main) return;
    this.startHidden = true;
    this.createMain();
  }
}

function titleSymbolColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#f5f5f7" : "#1d1d1f";
}
