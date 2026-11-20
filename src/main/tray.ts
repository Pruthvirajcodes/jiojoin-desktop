import { Menu, Tray, app, nativeImage } from "electron";
import type { AppState, LineState } from "@shared/types";
import { assetPath } from "./paths";

interface Actions {
  open(): void;
  openRecents(): void;
  reconnect(): void;
  disconnect(): void;
  quit(): void;
}

export function lineSummary(line: LineState): string {
  switch (line.status) {
    case "registered":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "retrying":
      return "Not connected. Retrying";
    case "offline":
      return "Disconnected";
    case "needs-otp":
      return "Needs authorising";
    case "signed-out":
      return "Not set up";
  }
}

/** Menu-bar / notification-area presence: the app lives here when its window is closed. */
export class AppTray {
  private readonly tray: Tray;
  private lastKey = "";

  constructor(private readonly actions: Actions) {
    this.tray = new Tray(this.icon(false));
    this.tray.setToolTip("JioJoin");
    // On macOS a click opens the menu; elsewhere a click opens the window.
    if (process.platform !== "darwin") this.tray.on("click", () => actions.open());
  }

  update(state: AppState): void {
    // The engine still reports its unregister after quit has torn the tray down.
    if (this.tray.isDestroyed()) return;
    const missed = state.missedCount;
    const key = `${state.line.status}|${missed}|${state.account ? 1 : 0}|${state.call?.state ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const summary = lineSummary(state.line);
    this.tray.setImage(this.icon(missed > 0));
    this.tray.setToolTip(missed > 0 ? `JioJoin: ${missed} missed` : `JioJoin: ${summary}`);
    if (process.platform === "darwin") app.dock?.setBadge(missed > 0 ? String(missed) : "");

    const signedIn = state.account !== null;
    const canConnect =
      signedIn &&
      (state.line.status === "offline" || state.line.status === "retrying" || state.line.status === "needs-otp");
    const canDisconnect =
      signedIn && (state.line.status === "registered" || state.line.status === "connecting");

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: summary, enabled: false },
        { type: "separator" },
        { label: "Open JioJoin", click: () => this.actions.open() },
        {
          label: missed === 1 ? "1 Missed Call" : `${missed} Missed Calls`,
          visible: missed > 0,
          click: () => this.actions.openRecents(),
        },
        { type: "separator" },
        { label: "Reconnect", visible: canConnect, click: () => this.actions.reconnect() },
        { label: "Disconnect", visible: canDisconnect, click: () => this.actions.disconnect() },
        { type: "separator", visible: canConnect || canDisconnect },
        { label: "Quit JioJoin", click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }

  private icon(missed: boolean) {
    if (process.platform === "darwin") {
      const image = nativeImage.createFromPath(
        assetPath(missed ? "trayMissedTemplate.png" : "trayTemplate.png"),
      );
      image.setTemplateImage(true);
      return image;
    }
    return nativeImage.createFromPath(assetPath(missed ? "tray-missed.png" : "tray.png"));
  }
}
