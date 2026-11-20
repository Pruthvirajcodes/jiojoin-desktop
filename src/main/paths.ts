import { join } from "node:path";
import { app } from "electron";

/** Icons and other files shipped beside the app bundle. */
export function assetPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, "assets", name)
    : join(app.getAppPath(), "resources", name);
}

export function engineBinaryPath(): string {
  const file = process.platform === "win32" ? "jiojoin-engine.exe" : "jiojoin-engine";
  if (process.env.JIOJOIN_ENGINE_PATH) return process.env.JIOJOIN_ENGINE_PATH;
  return app.isPackaged
    ? join(process.resourcesPath, "engine", file)
    : join(app.getAppPath(), "engine", "dist", `${process.platform}-${process.arch}`, file);
}

export function dataPath(name: string): string {
  return join(app.getPath("userData"), name);
}
