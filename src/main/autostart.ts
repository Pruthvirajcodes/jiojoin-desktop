import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

const LINUX_ENTRY = join(homedir(), ".config", "autostart", "jiojoin-desktop.desktop");

/** Registers or removes the app as a login item. No-op in development. */
export function setLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (process.platform === "linux") {
    // Electron has no login-item API on Linux; the XDG autostart entry is the standard.
    if (!enabled) {
      rmSync(LINUX_ENTRY, { force: true });
      return;
    }
    const executable = process.env.APPIMAGE ?? process.execPath;
    mkdirSync(join(LINUX_ENTRY, ".."), { recursive: true });
    writeFileSync(
      LINUX_ENTRY,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=JioJoin Desktop",
        `Exec="${executable}"`,
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"),
    );
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}
