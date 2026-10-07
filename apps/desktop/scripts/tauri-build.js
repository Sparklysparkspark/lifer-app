// Wraps `tauri build`, reading extra args from TAURI_BUILD_ARGS in Node, since cmd.exe on the
// Windows runner doesn't expand $VAR in package.json scripts. LIFER_TARGET_TRIPLE (see
// target.js) adds --target, so the Rust build and the sidecar name match the other steps.
import { spawnSync } from "node:child_process";
import { target } from "./target.js";

const extraArgs = (process.env.TAURI_BUILD_ARGS ?? "").split(" ").filter(Boolean);
if (target.triple) extraArgs.push("--target", target.triple);
const result = spawnSync("npx", ["tauri", "build", ...extraArgs], { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
