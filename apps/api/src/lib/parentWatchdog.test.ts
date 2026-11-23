import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modulePath = fileURLToPath(new URL("./parentWatchdog.ts", import.meta.url));

// A child that exits with 7 when onParentGone fires, and otherwise stays up.
function child(env: Record<string, string>) {
  const code = `const { onParentGone } = await import(${JSON.stringify(modulePath)});
onParentGone(() => process.exit(7));
setInterval(() => {}, 1000);
process.stdout.write("ready\\n");`;
  const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: { ...process.env, LIFER_PARENT_STDIN: "", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const ready = new Promise<void>((resolve) => proc.stdout.once("data", () => resolve()));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (c) => resolve(c)));
  return { proc, ready, exited };
}

describe("onParentGone", () => {
  it("fires when stdin closes and the parent owns it", async () => {
    const { proc, ready, exited } = child({ LIFER_PARENT_STDIN: "1" });
    await ready;
    proc.stdin.end();
    expect(await exited).toBe(7);
  }, 30_000);

  it("ignores stdin without the flag, as on a server", async () => {
    const { proc, ready, exited } = child({});
    await ready;
    proc.stdin.end();
    const outcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r("alive"), 1500))]);
    proc.kill();
    expect(outcome).toBe("alive");
  }, 30_000);
});
