// Quick manual check of a built engine: `bun run engine:smoke [path-to-binary]`.
import { spawn } from "node:child_process";
import { join } from "node:path";

const binary =
  process.argv[2] ??
  join(
    import.meta.dirname,
    "..",
    "dist",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "jiojoin-engine.exe" : "jiojoin-engine",
  );

const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
const timeout = setTimeout(() => {
  console.error("smoke: engine did not answer");
  child.kill();
  process.exit(1);
}, 15_000);

let buffer = "";
child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.event === "ready") child.stdin.write('{"id":1,"cmd":"hello"}\n');
    if (message.id === 1) {
      console.log(message);
      const codecs: string[] = message.codecs ?? [];
      const ok =
        message.tls === true &&
        codecs.some((codec) => codec.startsWith("AMR-WB/")) &&
        codecs.some((codec) => codec.startsWith("AMR/"));
      child.stdin.write('{"id":2,"cmd":"quit"}\n');
      clearTimeout(timeout);
      child.once("exit", () => {
        console.log(ok ? "smoke: OK (TLS, AMR-WB, AMR-NB)" : "smoke: FAILED");
        process.exit(ok ? 0 : 1);
      });
    }
  }
});
