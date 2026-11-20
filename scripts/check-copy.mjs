#!/usr/bin/env node
// Lints the English copy in en.json for house-style slips: emoji, ellipses on action labels, Lifer
// jargon, platform words, "New:"/"experimental", a stray "Select all", and long descriptions (warn).
// Known hits live in copy-allowlist.json, keyed by rule then en.json key path, so only new slips fail.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function flatten(obj, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(full, value);
    else if (value && typeof value === "object") flatten(value, full, out);
  }
  return out;
}

const lastSegment = (key) => key.slice(key.lastIndexOf(".") + 1);
// Progress text ("Saving…") and placeholders legitimately end in an ellipsis; action labels don't.
const isActionKey = (key) =>
  /(button|action|submit|confirm|cta|menuItem)$/i.test(lastSegment(key)) || /(^|\.)(menu|photoMenu)\./.test(key);
const isProgress = (text) => /^\W*\w+ing\b/i.test(text);

// Whole-word matches so "package" or "tiered" never trip the jargon rule. The arrow marks an
// external link and is allowed.
const EMOJI = /(?![↗])\p{Extended_Pictographic}/u;
const JARGON = /\b(packs?|taxa|taxon|tiers?|ghosts?|sea zones?|instances?|drill in|bulk import)\b/i;
const PLATFORM = /\b(Mac|macOS|Finder|Explorer|browser)\b|⌘/;
const STALE = /\bNew:|\bexperimental\b/i;
const SELECT_ALL = /\bselect all\b/i;
const SHARED_TOGGLE = /^ui\.select\./;
const isDescription = (key) => /(description|hint|help|body)$/i.test(lastSegment(key));

export const RULES = {
  emoji: (k, t) => EMOJI.test(t),
  ellipsis: (k, t) => isActionKey(k) && /(\.\.\.|…)\s*$/.test(t) && !isProgress(t),
  jargon: (k, t) => JARGON.test(t),
  platform: (k, t) => PLATFORM.test(t),
  stale: (k, t) => STALE.test(t),
  selectAll: (k, t) => SELECT_ALL.test(t) && !SHARED_TOGGLE.test(k),
};
export const MAX_DESCRIPTION = 140;

// ICU argument names ({taxon}, {count, plural...}) and rich-text tags are code, not copy.
const prose = (text) => text.replace(/\{\s*\w+\s*(?=[,}])/g, "{").replace(/<\/?\w+>/g, "");

// Returns { errors, warnings } as printable lines.
export function checkCopy(messages, allowlist = {}) {
  const errors = [];
  const warnings = [];
  for (const [key, raw] of messages) {
    const text = prose(raw);
    for (const [rule, test] of Object.entries(RULES)) {
      if (test(key, text) && !allowlist[rule]?.includes(key)) errors.push(`${rule}: "${key}": ${text}`);
    }
    if (isDescription(key) && raw.length > MAX_DESCRIPTION) {
      warnings.push(`long: "${key}" is ${raw.length} characters (keep under ${MAX_DESCRIPTION})`);
    }
  }
  return { errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const en = JSON.parse(readFileSync(join(root, "apps/web/src/locales/en.json"), "utf8"));
  const allowlist = JSON.parse(readFileSync(join(root, "scripts/copy-allowlist.json"), "utf8"));
  const messages = flatten(en);
  const { errors, warnings } = checkCopy(messages, allowlist);
  if (process.argv.includes("--baseline")) {
    const next = {};
    for (const line of errors) {
      const [, rule, key] = /^(\w+): "([^"]+)"/.exec(line);
      (next[rule] ??= []).push(key);
    }
    console.log(JSON.stringify(next, null, 2));
    process.exit(0);
  }
  for (const w of warnings) console.warn(`warning ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(
      `\n${errors.length} copy problem(s). Fix the wording, or for a technical setting add the key to scripts/copy-allowlist.json.`,
    );
    process.exit(1);
  }
  console.log(`Copy check passed (${messages.size} messages, ${warnings.length} warning(s)).`);
}
