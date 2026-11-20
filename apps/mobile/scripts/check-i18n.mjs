#!/usr/bin/env node
// Every t("key") literal in apps/mobile/src exists in en.json, and every en.json key is used.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? n === "locales"
        ? []
        : files(p)
      : /\.tsx?$/.test(n) && !n.includes(".test.")
        ? [p]
        : [];
  });
const flatten = (o, prefix = "") =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [prefix + k] : flatten(v, `${prefix}${k}.`)));

const keys = new Set(flatten(JSON.parse(readFileSync(join(src, "locales/en.json"), "utf8"))));
const code = files(src)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const errors = [];
for (const m of code.matchAll(/\bt\(\s*"([\w.]+)"/g)) if (!keys.has(m[1])) errors.push(`missing in en.json: ${m[1]}`);
// Keys named as whole string literals count as used (tab labels live in navigation/tabs.ts).
for (const k of keys)
  if (!code.includes(`"${k}"`) && !k.startsWith("connect.errors.")) errors.push(`unused in en.json: ${k}`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("check:i18n ok");
