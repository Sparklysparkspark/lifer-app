// Wraps `tauri build`, reading extra args from TAURI_BUILD_ARGS in Node, since cmd.exe on the
// Windows runner doesn't expand $VAR in package.json scripts.
import { spawnSync } from "node:child_process";

const extraArgs = (process.env.TAURI_BUILD_ARGS ?? "").split(" ").filter(Boolean);
const result = spawnSync("npx", ["tauri", "build", ...extraArgs], { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
