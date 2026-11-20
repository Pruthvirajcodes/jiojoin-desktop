import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { safeStorage } from "electron";
import { log } from "../logger";
import { readJson, removeFile, writeFileAtomic } from "./files";

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

function isVaultData(value: unknown): value is VaultData {
  const record = value as Partial<VaultData> | null;
  return typeof record?.deviceId === "string" && record.deviceId !== "";
}

/**
 * Keeps the sign-in, encrypted with the OS keychain (Electron safeStorage)
 * when one is usable.
 *
 * Without a usable keychain it is kept in a file only this user can read.
 * Losing it is worse than storing it plainly: the router's whitelist holds a
 * few devices (6 on lines seen so far) and evicts the oldest when a new id is
 * added, so a forgotten id costs the owner a text and another household
 * device its place on the line.
 */
export class Vault {
  private data: VaultData | null = null;
  /** A saved sign-in exists but the keychain refused to decrypt it. The file is kept. */
  unreadable = false;

  private constructor(
    /** "" for a vault that never touches the disk. */
    private readonly encryptedPath: string,
    private readonly plainPath: string,
    readonly secure: boolean,
  ) {}

  /** A vault that never touches the disk or the keychain, for demo mode. */
  static inMemory(): Vault {
    return new Vault("", "", false);
  }

  static async open(encryptedPath: string, plainPath: string): Promise<Vault> {
    // On Linux without a recognised keyring Electron falls back to a fixed
    // key, which is plain text in all but name; say so instead of pretending.
    const available = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
    const weak = process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text";
    const vault = new Vault(encryptedPath, plainPath, available && !weak);
    if (vault.secure) vault.data = await vault.readEncrypted();
    if (!vault.data && !vault.unreadable) {
      const plain = readJson<unknown>(plainPath, null);
      if (isVaultData(plain)) {
        vault.data = plain;
        // A keychain became available since: move the sign-in into it.
        if (vault.secure) await vault.set(plain);
      }
    }
    return vault;
  }

  get(): VaultData | null {
    return this.data;
  }

  /** Saves the sign-in. Resolves false when it could not be written. */
  async set(data: VaultData): Promise<boolean> {
    this.data = data;
    if (!this.encryptedPath) return true;
    try {
      if (this.secure) {
        const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(data));
        // A newer sign-in or a sign-out landed while the keychain was busy.
        if (this.data !== data) return true;
        writeFileAtomic(this.encryptedPath, encrypted);
        removeFile(this.plainPath);
      } else {
        writeFileAtomic(this.plainPath, JSON.stringify(data));
      }
      this.unreadable = false;
      return true;
    } catch (error) {
      log.error("vault", `could not save the sign-in: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Signs out of the line but keeps this install's device id, so signing in
   * again reuses the router's existing whitelist slot instead of taking a new
   * one (and evicting another device).
   */
  async forgetLine(): Promise<void> {
    const current = this.data;
    if (!current) return;
    await this.set({ deviceId: current.deviceId, deviceName: current.deviceName, number: "", onboarded: false });
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
    if (this.data?.onboarded) return false;
    try {
      const parsed = JSON.parse(text) as Partial<VaultData>;
      const deviceId = String(parsed.deviceId ?? "").trim().toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(deviceId)) return false;
      const deviceName = typeof parsed.deviceName === "string" ? parsed.deviceName.trim() : "";
      await this.set({ deviceId, deviceName: deviceName || "Desktop", number: "", onboarded: false });
      return true;
    } catch {
      return false;
    }
  }

  private async readEncrypted(): Promise<VaultData | null> {
    let raw: Buffer;
    try {
      raw = await readFile(this.encryptedPath);
    } catch {
      return null;
    }
    try {
      const { result } = await safeStorage.decryptStringAsync(raw);
      const parsed: unknown = JSON.parse(result);
      if (isVaultData(parsed)) return parsed;
    } catch {
      // Fall through: keep the file, a later keychain approval may read it.
    }
    this.unreadable = true;
    log.warn("vault", "the saved sign-in couldn't be read from the keychain; keeping the file");
    return null;
  }
}
