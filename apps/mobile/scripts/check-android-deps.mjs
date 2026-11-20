#!/usr/bin/env node
// After a prebuild: the Android release classpath must hold no Google ML Kit or Play Services scanner code.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const android = join(dirname(fileURLToPath(import.meta.url)), "..", "android");
const tree = execFileSync("./gradlew", ["-q", ":app:dependencies", "--configuration", "releaseRuntimeClasspath"], {
  cwd: android,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const bad = [...new Set(tree.match(/com\.google\.mlkit:[^\s]+|play-services-(?:mlkit|code-scanner)[^\s]*/g) ?? [])];
if (bad.length) {
  console.error(`Google scanner code is in the Android build:\n${bad.join("\n")}`);
  process.exit(1);
}
console.log("check:android-deps ok");
