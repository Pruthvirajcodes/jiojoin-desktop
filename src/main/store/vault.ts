import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { safeStorage } from "electron";
import { log } from "../logger";
import { removeFile, writeFileAtomic } from "./files";

/**
 * What identifies this install to the router. The device id is the real
 * credential: any LAN device presenting a whitelisted id is handed the SIP
 * password. The SIP password itself is never stored; it is fetched fresh
 * before every registration and lives only in memory.
 */
export interface VaultData {
  deviceId: string;
  deviceName: string;
  /** The line's number, kept so the UI can show it before the router answers. */
  number: string;
  onboarded: boolean;
}

/** A locally administered, unicast MAC-style identifier. */
export function generateDeviceId(): string {
  const bytes = randomBytes(6);
  bytes[0] = ((bytes[0] ?? 0) & 0xfc) | 0x02;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

/** Keeps the sign-in encrypted with the OS keychain (Electron safeStorage). */
export class Vault {
  private data: VaultData | null = null;

  private constructor(
    private readonly path: string,
    readonly secure: boolean,
  ) {}

  /** A vault that never touches the disk or the keychain, for demo mode. */
  static inMemory(): Vault {
    return new Vault("", false);
  }

  static async open(path: string): Promise<Vault> {
    // On Linux without a keyring Electron falls back to a fixed key, which is
    // plain text in all but name. Keep the sign-in in memory only then.
    const available = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
    const weak = process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text";
    const vault = new Vault(path, available && !weak);
    if (vault.secure) vault.data = await vault.read();
    return vault;
  }

  get(): VaultData | null {
    return this.data;
  }

  set(data: VaultData): void {
    this.data = data;
    if (!this.secure) return;
    void safeStorage
      .encryptStringAsync(JSON.stringify(data))
      .then((encrypted) => {
        // A sign-out may have landed while the keychain was busy.
        if (this.data === data) writeFileAtomic(this.path, encrypted);
      })
      .catch(() => log.error("vault", "could not save the sign-in to the keychain"));
  }

  /**
   * Takes over a device id the router already trusts, such as one from an
   * earlier JioJoin app, so onboarding can skip the text-message code. The
   * file holds {"deviceId": "aa:bb:cc:dd:ee:ff", "deviceName"?: "..."} and is
   * deleted once read. The router still decides: an unknown id gets the OTP flow.
   */
  async adoptImport(path: string): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return false;
    }
    await rm(path, { force: true });
    if (this.data) return false;
    try {
      const parsed = JSON.parse(text) as Partial<VaultData>;
      const deviceId = String(parsed.deviceId ?? "").trim().toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(deviceId)) return false;
      const deviceName = typeof parsed.deviceName === "string" ? parsed.deviceName.trim() : "";
      this.set({ deviceId, deviceName: deviceName || "Desktop", number: "", onboarded: false });
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.data = null;
    if (this.path) removeFile(this.path);
  }

  private async read(): Promise<VaultData | null> {
    try {
      const { result } = await safeStorage.decryptStringAsync(await readFile(this.path));
      const parsed = JSON.parse(result) as VaultData;
      return typeof parsed.deviceId === "string" && parsed.deviceId !== "" ? parsed : null;
    } catch {
      return null;
    }
  }
}
