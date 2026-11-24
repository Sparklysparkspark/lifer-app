import assert from "node:assert/strict";
import { test } from "node:test";
import { deadThumbs, keymapHash, lineHits, reversibleConfirms } from "./check-ux-code.mjs";

test("raw error text, count templates and the product name are flagged", () => {
  const rules = (text, file) => lineHits(text, file).map((h) => h.rule);
  assert.deepEqual(rules("<p>{err.message}</p>"), ["rawError"]);
  assert.deepEqual(rules("<p>{err.message}</p>", "components/Toast.tsx"), []);
  assert.deepEqual(rules("toast.error(`${n} photos couldn't be rated`)"), ["countTemplate"]);
  assert.deepEqual(rules('toast.error(errorMessage(err, t("x.failed")))'), []);
  assert.deepEqual(rules('const href = "https://preenwildlife.com";'), ["productName"]);
});

test("a confirm that promises Undo is flagged; an escape comment silences it", () => {
  const messages = new Map([["a.msg", "You can unarchive them from Settings."]]);
  assert.equal(reversibleConfirms('await confirm({ message: t("a.msg") });', messages).length, 1);
  assert.equal(reversibleConfirms('// confirm-ok: why\nawait confirm({ message: t("a.msg") });', messages).length, 0);
});

test("a photo needs a clickable ancestor", () => {
  assert.equal(deadThumbs("const A = () => <img src={thumbUrl(id)} alt='' />;").length, 1);
  assert.equal(deadThumbs("const A = () => <Link to='/x'><img src={thumbUrl(id)} alt='' /></Link>;").length, 0);
});

test("the keymap hash ignores formatting but not chords", () => {
  const a = keymapHash("export const KEYMAP = {\n  next: { keys: ['ArrowRight'] },\n};");
  assert.equal(a, keymapHash("export const KEYMAP = {\n  next: {keys: ['ArrowRight']}, // comment\n};"));
  assert.notEqual(a, keymapHash("export const KEYMAP = {\n  next: { keys: ['KeyL'] },\n};"));
});
