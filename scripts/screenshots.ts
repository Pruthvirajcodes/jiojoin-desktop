// Captures every main screen from the real Electron app running in demo mode.
// Usage: bun run build && bun run screenshots
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const data = mkdtempSync(join(tmpdir(), "jiojoin-shots-"));
const electron = join(root, "node_modules", ".bin", "electron");

const result = spawnSync(electron, ["."], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    JIOJOIN_DEMO: "1",
    JIOJOIN_DEMO_DATA: data,
    JIOJOIN_SHOTS: join(root, "docs", "screenshots"),
  },
});
rmSync(data, { recursive: true, force: true });
process.exit(result.status ?? 1);
