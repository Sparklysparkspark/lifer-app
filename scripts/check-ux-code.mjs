#!/usr/bin/env node
// UX rules that need the web code, not just en.json (docs/plans/ux-rules.md):
//   rawError (S10)          the UI renders err.message, a job's status.error or a stop reason;
//                           use errorMessage(err, fallback).
//   countTemplate (W13)     a template literal puts a number before a counted noun ("1 photos");
//                           use an en.json key with an ICU plural.
//   reversibleConfirm (F7)  a confirm() whose copy says the action can be undone; act at once
//                           and offer Undo. Escape: a `confirm-ok: <why>` comment above the call.
//   deadThumb (C12)         a photo <img> with no clickable ancestor, so it can't open full size.
//                           Escape: a `dead-thumb-ok: <why>` comment above the tag.
//   productName             the add-on's product name in code (it lives in data/suggestedApps.json).
// Today's known hits live in ux-code-baseline.json; it may only shrink.
// Also fails when the keyboard map changes without refreshing keymap.hash (K1): the companion app
// keeps a copy of these shortcuts, so a change there must be mirrored before the hash is updated.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { flatten } from "./check-copy.mjs";
import { diffBaseline } from "./check-raw-controls.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const webSrc = join(root, "apps", "web", "src");
const baselinePath = join(here, "ux-code-baseline.json");
const keymapHashPath = join(here, "keymap.hash");

// The error path itself, and the toast, confirm and crash components that render a message they were given.
const ERROR_HOMES = new Set([
  "lib/errorMessage.ts",
  "api/client.ts",
  "components/Toast.tsx",
  "components/ConfirmProvider.tsx",
  "components/CrashBoundary.tsx",
]);
const RAW_ERROR = [
  /instanceof ApiError\s*\?\s*\w+\.message\b/,
  /\{\s*\w+\??\.(message|stopReason)\s*\}/,
  /\$\{\s*\w+\??\.(message|stopReason)\s*\}/,
  /toast\.\w+\(\s*\w+\??\.(message|error|stopReason)\b/,
  /\bt\([^)]*\berror:\s*\w+\??\.(error|message)\b/,
];
const COUNT_TEMPLATE =
  /\$\{[^}]+\}\s+(photos?|files?|sightings?|species|versions?|albums?|videos?|originals?|downloads?)\b/;
const REVERSIBLE =
  /\b(restore|unarchive|unhide|undo)\b|nothing is (lost|deleted)|stays? in (the )?Trash|put (it|them) back|bring(s)? it (right )?back|you can .{0,40}\bback\b/i;
const PRODUCT = /\bPreen\b|preenwildlife/i;
const THUMB_SRC = /thumb|display|preview|Url\b/i;
// Clickable ancestors, or components that make their image open the viewer themselves.
const OPENS = /^(button|a|Button|IconButton|Link|PhotoTile|PhotoGrid|Thumb|MediaCard|MosaicPhoto|Lightbox)$/;
const OPEN_PROPS = /^(onClick|onOpen|onSelect|onActivate|to|href)$/;

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const escapedBy = (lines, line, word) => new RegExp(`${word}:\\s*\\S`).test(lines[line - 2] ?? "");

/** Line-pattern hits for rawError, countTemplate and productName in one file's text. */
export function lineHits(text, file = "") {
  const hits = [];
  text.split("\n").forEach((l, i) => {
    if (!ERROR_HOMES.has(file) && RAW_ERROR.some((re) => re.test(l))) hits.push({ rule: "rawError", line: i + 1 });
    if (COUNT_TEMPLATE.test(l)) hits.push({ rule: "countTemplate", line: i + 1 });
    if (PRODUCT.test(l)) hits.push({ rule: "productName", line: i + 1 });
  });
  return hits;
}

/** confirm({ ... }) calls whose t() keys resolve to copy that says the action is reversible. */
export function reversibleConfirms(text, messages) {
  const lines = text.split("\n");
  const hits = [];
  for (const m of text.matchAll(/\bconfirm\(\s*\{/g)) {
    const line = lineOf(text, m.index);
    if (escapedBy(lines, line, "confirm-ok")) continue;
    const end = text.indexOf("})", m.index);
    const body = text.slice(m.index, end === -1 ? undefined : end);
    const copy = [...body.matchAll(/\bt\(\s*"([\w.]+)"/g)].map((k) => messages.get(k[1]) ?? "").join(" ");
    if (REVERSIBLE.test(copy)) hits.push({ rule: "reversibleConfirm", line });
  }
  return hits;
}

/** <img> tags showing a photo with no clickable ancestor in the same component. */
export function deadThumbs(text, file = "x.tsx") {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split("\n");
  const hits = [];
  const tagName = (n) => n.tagName.getText(sf);
  const opens = (opening) =>
    OPENS.test(tagName(opening)) ||
    opening.attributes.properties.some((p) => ts.isJsxAttribute(p) && OPEN_PROPS.test(p.name.getText(sf)));
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && tagName(node) === "img") {
      const src = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "src");
      if (src && THUMB_SRC.test(src.getText(sf)) && !opens(node)) {
        let clickable = false;
        for (let p = node.parent; p && !clickable && !ts.isSourceFile(p); p = p.parent) {
          if (ts.isJsxElement(p)) clickable = opens(p.openingElement);
          if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) break;
        }
        const line = lineOf(text, node.getStart(sf));
        if (!clickable && !escapedBy(lines, line, "dead-thumb-ok")) hits.push({ rule: "deadThumb", line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Hash of the KEYMAP object literal's text, whitespace-insensitive. */
export function keymapHash(text) {
  const start = text.indexOf("export const KEYMAP");
  const end = text.indexOf("\n};", start);
  return createHash("sha256")
    .update(
      text
        .slice(start, end)
        .replace(/\/\/.*$/gm, "")
        .replace(/\s+/g, ""),
    )
    .digest("hex")
    .slice(0, 16);
}

// Self-check, so a broken pattern can't pass every file silently.
assert.deepEqual(
  lineHits(
    [
      'setError(err instanceof ApiError ? err.message : "x");',
      "<p>{error.message}</p>",
      "toast.error(status.error);",
      't("a.failed", { error: job.error })',
      "toast.error(`${failed} of ${results.length} photos couldn't be reassigned`);",
      'toast.error(errorMessage(err, t("a.failed")));',
      "const name = 'Preen';",
    ].join("\n"),
  ).map((h) => `${h.rule}:${h.line}`),
  ["rawError:1", "rawError:2", "rawError:3", "rawError:4", "countTemplate:5", "productName:7"],
);
assert.deepEqual(
  reversibleConfirms(
    [
      'await confirm({ title: t("a.title"), message: t("a.undoable") });',
      "// confirm-ok: the RAW can't come back",
      'await confirm({ title: t("a.undoable") });',
      'await confirm({ title: t("a.final") });',
    ].join("\n"),
    new Map([
      ["a.title", "Unhide all?"],
      ["a.undoable", "Deleted photos stay in Trash for 7 days, where you can restore them."],
      ["a.final", "Delete permanently?"],
    ]),
  ).map((h) => h.line),
  [1],
);
assert.deepEqual(
  deadThumbs(
    [
      "const A = () => <div><img src={thumbUrl(id)} alt='' /></div>;",
      "const B = () => <button onClick={open}><img src={thumbUrl(id)} alt='' /></button>;",
      "const C = () => <div onClick={open}><span><img src={p.previewUrl} alt='' /></span></div>;",
      "const D = () => <img src='/logo.png' alt='' />;",
      "const E = () => (",
      "  // dead-thumb-ok: decorative backdrop",
      "  <img src={displayUrl} alt='' />",
      ");",
    ].join("\n"),
  ).map((h) => h.line),
  [1],
);
assert.equal(
  keymapHash("export const KEYMAP = {\n  a: 1, // x\n};"),
  keymapHash("export const KEYMAP = {\n a:  1,\n};"),
);
assert.notEqual(keymapHash("export const KEYMAP = {\n  a: 1,\n};"), keymapHash("export const KEYMAP = {\n  a: 2,\n};"));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "locales"
        ? []
        : walk(join(dir, e.name))
      : /\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

function scan() {
  const messages = flatten(JSON.parse(readFileSync(join(webSrc, "locales", "en.json"), "utf8")));
  return walk(webSrc).flatMap((abs) => {
    const file = relative(webSrc, abs).split("\\").join("/");
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const hits = [
      ...lineHits(text, file),
      ...reversibleConfirms(text, messages),
      ...(file.endsWith(".tsx") ? deadThumbs(text, file) : []),
    ];
    return hits.map(({ rule, line }) => ({ file, text: `${rule}: ${lines[line - 1].trim()}`, line }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keymap = keymapHash(readFileSync(join(webSrc, "lib", "keymap.ts"), "utf8"));
  if (process.argv.includes("--update-keymap-hash")) {
    writeFileSync(keymapHashPath, `${keymap}\n`);
    console.log("Wrote keymap.hash.");
    process.exit(0);
  }
  if (readFileSync(keymapHashPath, "utf8").trim() !== keymap) {
    console.error(
      "The keyboard map (apps/web/src/lib/keymap.ts) changed. Mirror the change in the companion app's copy of the shortcuts, then run: node scripts/check-ux-code.mjs --update-keymap-hash",
    );
    process.exit(1);
  }
  const found = scan();
  if (process.argv.includes("--write-baseline")) {
    const entries = found.map(({ file, text }) => ({ file, text }));
    writeFileSync(baselinePath, JSON.stringify(entries, null, 2) + "\n");
    console.log(`Wrote ${entries.length} baseline entries.`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { fresh, gone } = diffBaseline(found, baseline);
  if (fresh.length) {
    console.error(fresh.map((f) => `apps/web/src/${f.file}:${f.line}: ${f.text}`).join("\n"));
    console.error(
      `\n${fresh.length} new UX code problem(s). See the rule list at the top of scripts/check-ux-code.mjs and docs/plans/ux-rules.md.`,
    );
    process.exit(1);
  }
  if (gone) console.log(`Baseline shrank by ${gone}: please update it with --write-baseline.`);
  console.log(`No new UX code problems (${baseline.length - gone} known, in ux-code-baseline.json).`);
}
