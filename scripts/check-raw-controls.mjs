#!/usr/bin/env node
// Fails when code in apps/web/src hand-builds a control the shared components already cover
// (<button>, <select>, <textarea>, or an <input> other than a file or hidden one) or a lookalike
// overlay (`fixed inset-0`, role="dialog", role="menu"). Use Button, IconButton, Select, TextField,
// TextArea, SearchInput, Checkbox, Switch, SegmentedControl, Modal or Menu.
// A justified one-off (a whole photo tile that is the button) carries a comment on the line just
// above it: `raw-control: <why>`.
// Also fails on a <Button> in pages/settings/ without size="sm", so Settings keeps one button size,
// and on a hand-built card piece (a select tick, a dark overlay pill or a non-accent selection
// ring): use SelectMark, IconButton tone="overlay" or MediaCard (docs/plans/shared-card.md),
// and on a local copy of the per-photo menu's items: use PhotoMenu (docs/plans/shared-photo-grid.md).
// Today's known violations live in raw-controls-baseline.json; it may only shrink.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = join(root, "apps", "web", "src");
const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "raw-controls-baseline.json");
const ALLOWED_INPUT_TYPES = /\btype=["'](file|hidden)["']/;
const ESCAPE = /raw-control:\s*\S/;
// The lookbehind skips CSS selectors such as querySelector('[role="dialog"]').
// A dialog is a Modal with size="sm" | "md" | "lg"; aria-modal or a native <dialog> is a second one.
const OVERLAY =
  /\bfixed\b[^"'`]*\binset-0\b|\binset-0\b[^"'`]*\bfixed\b|(?<![[\w-])role=["'](dialog|alertdialog|menu)["']|\baria-modal\b|<dialog\b/;
// The shared components own the raw markup; the components folder is flat, so list them.
const SHARED = new Set(
  [
    "Button",
    "Select",
    "TextField",
    "SearchInput",
    "Checkbox",
    "Switch",
    "Slider",
    "StarRangePicker",
    "SegmentedControl",
    "Pill",
    "Menu",
    "Modal",
    "ConfirmDialog",
  ].map((n) => `components/${n}.tsx`),
);

// Card pieces have one home each; no escape comment, since a local copy is exactly the drift.
const CARD_PIECE = /\bh-4 w-4 accent-accent\b|\bring-blue-\d|\bbg-black\/\d+\b[^"`]*\bhover:bg-black\//;
const CARD_PIECE_HOMES = new Set([
  "components/SelectMark.tsx",
  "components/MediaCard.tsx",
  // The big previous and next arrows over a photo (Lightbox, species carousel, compare), not a card's overlay.
  "components/PhotoArrows.tsx",
]);

// The per-photo menu has one home; a page adds its own items through PhotoMenu's slots.
const PHOTO_MENU_PIECE =
  /<(RevealOriginalMenuItem|SendToInatMenuItem|ViewOnInatMenuItem|OpenInMenuItems)\b|t\("photoMenu\.(viewSpecies|similar|addToAlbum|editTags|correctId|downloadOriginal|downloadRaw|copyPath|hide|delete)"/;
const PHOTO_MENU_HOMES = new Set(["components/PhotoMenu.tsx", "components/SendToInatMenuItem.tsx"]);

/** Line numbers in `text` that copy one of the shared photo menu's items. */
export function photoMenuPieces(text) {
  return text.split("\n").flatMap((l, i) => (PHOTO_MENU_PIECE.test(l) ? [i + 1] : []));
}

/** Line numbers in `text` that hand-build a select tick, overlay pill or selection ring. */
export function cardPieces(text) {
  return text.split("\n").flatMap((l, i) => (CARD_PIECE.test(l) ? [i + 1] : []));
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name.endsWith(".tsx") && !/\.test\./.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

/** Raw controls and lookalike overlays in one file's text that lack an escape comment. */
export function rawControls(text) {
  const lines = text.split("\n");
  const found = [];
  const escaped = (line) => ESCAPE.test(lines[line - 2] ?? "");
  // An arrow function's => inside the attributes isn't the tag's end.
  for (const m of text.matchAll(/<(button|select|textarea|input)\b((?:=>|[^>])*)/g)) {
    const [, tag, attrs] = m;
    if (tag === "input" && ALLOWED_INPUT_TYPES.test(attrs)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    if (escaped(line)) continue;
    found.push({ line, tag });
  }
  lines.forEach((l, i) => {
    if (OVERLAY.test(l) && !escaped(i + 1)) found.push({ line: i + 1, tag: "overlay" });
  });
  return found.sort((a, b) => a.line - b.line);
}

/** Line numbers of <Button> tags (single or multi-line) in `text` that lack size="sm". */
export function unsizedButtons(text) {
  // An arrow function's => inside the attributes isn't the tag's end.
  return [...text.matchAll(/<Button\b((?:=>|[^>])*)/g)]
    .filter((m) => !/\bsize=["']sm["']/.test(m[1]))
    .map((m) => text.slice(0, m.index).split("\n").length);
}

/** Entries in `found` beyond what `baseline` allows, and baseline entries that no longer occur. */
export function diffBaseline(found, baseline) {
  const key = (e) => `${e.file}\n${e.text}`;
  const left = new Map();
  for (const b of baseline) left.set(key(b), (left.get(key(b)) ?? 0) + 1);
  const fresh = [];
  for (const f of found) {
    const n = left.get(key(f)) ?? 0;
    if (n > 0) left.set(key(f), n - 1);
    else fresh.push(f);
  }
  const gone = [...left.values()].reduce((a, b) => a + b, 0);
  return { fresh, gone };
}

// Self-check, so a broken pattern can't pass every file silently.
assert.deepEqual(
  rawControls(
    [
      '<input type="file" onChange={(e) => go(e)} />',
      '<input onChange={(e) => go(e)} type="hidden" />',
      "{/* raw-control: the tile is the button */}",
      "<button onClick={open}>",
      "<select value={v}>",
    ].join("\n"),
  ),
  [{ line: 5, tag: "select" }],
);
assert.deepEqual(
  rawControls(
    [
      '<div className="fixed inset-0 z-50">',
      "{/* raw-control: the lightbox owns its backdrop */}",
      '<div role="dialog">',
      '<ul role="menu">',
      '<div role="menuitem">',
      "document.querySelector('[role=\"dialog\"]');",
      '<div className="inset-0 z-50 fixed bg-surface">',
      '<div aria-modal="true">',
      "<dialog open>",
      '<div className="absolute inset-0">',
    ].join("\n"),
  ),
  [
    { line: 1, tag: "overlay" },
    { line: 4, tag: "overlay" },
    { line: 7, tag: "overlay" },
    { line: 8, tag: "overlay" },
    { line: 9, tag: "overlay" },
  ],
);
assert.deepEqual(
  diffBaseline(
    [
      { file: "a", text: "x" },
      { file: "a", text: "x" },
      { file: "b", text: "y" },
    ],
    [
      { file: "a", text: "x" },
      { file: "c", text: "z" },
    ],
  ),
  {
    fresh: [
      { file: "a", text: "x" },
      { file: "b", text: "y" },
    ],
    gone: 1,
  },
);

assert.deepEqual(
  cardPieces(
    [
      'className="absolute left-2 top-2 h-4 w-4 accent-accent"',
      'className="h-4 w-4 shrink-0 accent-accent"',
      '"ring-2 ring-inset ring-blue-500"',
      'className="rounded-full bg-black/45 text-white hover:bg-black/65"',
      'className="rounded-full bg-black/40 px-1.5 text-white"',
    ].join("\n"),
  ),
  [1, 3, 4],
);

assert.deepEqual(
  photoMenuPieces(
    [
      "<RevealOriginalMenuItem originalRef={r} />",
      '{t("photoMenu.downloadRaw")}',
      '{t("photoMenu.unhide")}',
      "<PhotoMenu photo={p} />",
    ].join("\n"),
  ),
  [1, 2],
);

function scanPhotoMenuPieces() {
  return walk(webSrc).flatMap((abs) => {
    const file = relative(webSrc, abs).split("\\").join("/");
    if (PHOTO_MENU_HOMES.has(file)) return [];
    return photoMenuPieces(readFileSync(abs, "utf8")).map((line) => `apps/web/src/${file}:${line}`);
  });
}

function scanCardPieces() {
  return walk(webSrc).flatMap((abs) => {
    const file = relative(webSrc, abs).split("\\").join("/");
    if (CARD_PIECE_HOMES.has(file)) return [];
    return cardPieces(readFileSync(abs, "utf8")).map((line) => `apps/web/src/${file}:${line}`);
  });
}

function scan() {
  return walk(webSrc).flatMap((abs) => {
    const file = relative(webSrc, abs).split("\\").join("/");
    if (SHARED.has(file)) return [];
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    return rawControls(text).map(({ line, tag }) => ({ file, text: lines[line - 1].trim(), tag, line }));
  });
}

function scanSettingsButtons() {
  return walk(join(webSrc, "pages", "settings")).flatMap((abs) =>
    unsizedButtons(readFileSync(abs, "utf8")).map((line) => `${relative(root, abs)}:${line}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const unsized = scanSettingsButtons();
  if (unsized.length) {
    console.error(unsized.join("\n"));
    console.error(`\n${unsized.length} Settings <Button>(s) without size="sm". Settings uses one button size.`);
    process.exit(1);
  }
  const pieces = scanCardPieces();
  if (pieces.length) {
    console.error(pieces.join("\n"));
    console.error(
      `\n${pieces.length} hand-built card piece(s). Use SelectMark, IconButton tone="overlay", SelectedRing or MediaCard.`,
    );
    process.exit(1);
  }
  const menuPieces = scanPhotoMenuPieces();
  if (menuPieces.length) {
    console.error(menuPieces.join("\n"));
    console.error(
      `\n${menuPieces.length} local copy(ies) of photo menu items. Use PhotoMenu and its coverItems or endItems slots.`,
    );
    process.exit(1);
  }
  const found = scan();
  if (process.argv.includes("--write-baseline")) {
    const entries = found.map(({ file, text }) => ({ file, text }));
    (await import("node:fs")).writeFileSync(baselinePath, JSON.stringify(entries, null, 2) + "\n");
    console.log(`Wrote ${entries.length} baseline entries.`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { fresh, gone } = diffBaseline(found, baseline);
  if (fresh.length) {
    console.error(fresh.map((f) => `apps/web/src/${f.file}:${f.line}: raw ${f.tag}`).join("\n"));
    console.error(
      `\n${fresh.length} new raw control(s) or lookalike overlay(s). Use the shared components, or add a "raw-control: <why>" comment above a justified one-off.`,
    );
    process.exit(1);
  }
  if (gone) console.log(`Baseline shrank by ${gone}: please update it with --write-baseline.`);
  console.log("No new raw controls or lookalike overlays.");
}
