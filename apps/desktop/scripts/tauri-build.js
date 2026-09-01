// Thin wrapper around `tauri build` that reads extra CLI args from TAURI_BUILD_ARGS via
// Node's process.env rather than shell variable expansion — `npm run dist`'s script chain runs
// under cmd.exe on the Windows CI runner, which doesn't expand `$VAR`/`%VAR%` the way bash does,
// so embedding `$TAURI_BUILD_ARGS` directly in package.json's dist script broke Windows builds
// (cargo received the literal string "$TAURI_BUILD_ARGS" as an argument). Reading it here in
// Node sidesteps the shell entirely.
import { spawnSync } from "node:child_process";

const extraArgs = (process.env.TAURI_BUILD_ARGS ?? "").split(" ").filter(Boolean);
const result = spawnSync("npx", ["tauri", "build", ...extraArgs], { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
