#!/usr/bin/env node
// Copies the translator notes in apps/web/src/i18n/en.context.json into Weblate, as each English
// source string's "explanation" (shown to translators next to the string). JSON translation files
// can't carry comments, so the notes live in their own file and this keeps Weblate in step.
// See docs/docs/contributing/translating.md.
//
//   WEBLATE_URL=https://hosted.weblate.org WEBLATE_TOKEN=... WEBLATE_COMPONENT=lifer/web \
//     node scripts/i18n-weblate-context.mjs            # dry run: lists what would change
//     node scripts/i18n-weblate-context.mjs --apply    # writes the explanations
//
// The token needs permission to edit source strings in the project.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { WEBLATE_URL, WEBLATE_TOKEN, WEBLATE_COMPONENT } = process.env;
const apply = process.argv.includes("--apply");
if (!WEBLATE_URL || !WEBLATE_TOKEN || !WEBLATE_COMPONENT) {
  console.error("Set WEBLATE_URL, WEBLATE_TOKEN and WEBLATE_COMPONENT (project/component).");
  process.exit(1);
}

function flatten(obj, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(full, value);
    else flatten(value, full, out);
  }
  return out;
}
const notes = flatten(JSON.parse(readFileSync(join(root, "apps/web/src/i18n/en.context.json"), "utf8")));

const headers = { Authorization: `Token ${WEBLATE_TOKEN}`, "Content-Type": "application/json" };
async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

// The English translation's units are the source strings; for a monolingual JSON component a
// unit's context is its key (gallery.filters.hidden).
let url = `${WEBLATE_URL.replace(/\/$/, "")}/api/translations/${WEBLATE_COMPONENT}/en/units/`;
let changed = 0;
while (url) {
  const page = await call(url);
  for (const unit of page.results) {
    const wanted = notes.get(unit.context) ?? "";
    if ((unit.explanation ?? "") === wanted) continue;
    changed++;
    console.log(`${apply ? "set" : "would set"} ${unit.context}: ${wanted || "(cleared)"}`);
    if (apply) await call(`${WEBLATE_URL.replace(/\/$/, "")}/api/units/${unit.id}/`, { method: "PATCH", body: JSON.stringify({ explanation: wanted }) });
  }
  url = page.next;
}
console.log(`${changed} explanation(s) ${apply ? "updated" : "to update (dry run; pass --apply)"}.`);
