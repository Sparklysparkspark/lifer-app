import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCopy } from "./check-copy.mjs";

const run = (key, text, allow = {}) => checkCopy(new Map([[key, text]]), allow).errors.length;

test("emoji flagged, external-link arrow allowed", () => {
  assert.equal(run("a.b", "Great \u{1F600}"), 1);
  assert.equal(run("a.b", "eBird ↗"), 0);
});

test("ellipsis only on action keys, not progress text", () => {
  assert.equal(run("a.saveButton", "Save…"), 1);
  assert.equal(run("a.checkingButton", "Checking…"), 0);
  assert.equal(run("a.placeholder", "Search…"), 0);
  assert.equal(run("photoMenu.location", "Location…"), 1);
  assert.equal(run("x.menu.hiding", "Hiding…"), 0);
});

test("jargon matches whole words only", () => {
  assert.equal(run("a.b", "Download a pack"), 1);
  assert.equal(run("a.b", "Open the package"), 0);
  assert.equal(run("a.b", "Automatic URL Switching"), 0);
});

test("placeholder and tag names are not copy", () => {
  assert.equal(run("a.b", "Rarity: {tier}"), 0);
  assert.equal(run("a.b", "{count, plural, one {# {taxon} species} other {# {taxon} species}}"), 0);
  assert.equal(run("a.b", "Open <packLink>downloads</packLink>"), 0);
  assert.equal(run("a.b", "{count, plural, one {# pack} other {# packs}}"), 1);
});

test("platform words, stale labels and select all", () => {
  assert.equal(run("a.b", "Show in Finder"), 1);
  assert.equal(run("a.b", "New: filters"), 1);
  assert.equal(run("a.b", "This is experimental"), 1);
  assert.equal(run("a.b", "Select all"), 1);
});

test("allowlist silences a rule for a key only", () => {
  assert.equal(run("a.b", "Show in Finder", { platform: ["a.b"] }), 0);
  assert.equal(run("a.b", "Show in Finder", { jargon: ["a.b"] }), 1);
});

test("long descriptions warn without failing", () => {
  const r = checkCopy(new Map([["a.description", "x".repeat(141)]]));
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
});

test("a count before a noun needs plural syntax", () => {
  assert.equal(run("a.b", "Linked {count} photos to the checklist"), 1);
  assert.equal(run("a.b", "{done} of {total, number} files"), 1);
  assert.equal(run("a.b", "{count} species aren't covered"), 1);
  assert.equal(run("a.b", "Linked {count, plural, one {# photo} other {# photos}}"), 0);
  assert.equal(run("a.b", "{total, plural, one {{total} photo} other {{total} photos}} found"), 0);
  assert.equal(run("a.b", "{species} photos"), 0);
});

test("the add-on's names only on its offer, Select all only on the shared pair", () => {
  assert.equal(run("settings.apps.title", "Open Cull"), 1);
  assert.equal(run("suggestedApps.cull.title", "Preen culls a card"), 0);
  assert.equal(run("x.y", "Photos a culling app marked rejected"), 0);
  assert.equal(run("ui.selectAll", "Select all"), 0);
  assert.equal(run("ui.deselectAll", "Deselect all"), 0);
});

test("vocabulary flags a synonym in scope, unless allowed", () => {
  const terms = [
    { use: "Import", avoid: "\\bupload\\b", allow: ["upload.failed"] },
    { use: "Already in Lifer", avoid: "already in your library", keys: "^import\\." },
  ];
  const v = (key, text) => checkCopy(new Map([[key, text]]), {}, terms).errors.length;
  assert.equal(v("species.detail.upload", "Upload"), 1);
  assert.equal(v("upload.failed", "Upload failed"), 0);
  assert.equal(v("import.known.x", "Already in your library (3)"), 1);
  assert.equal(v("settings.x", "Photos already in your library"), 0);
});
