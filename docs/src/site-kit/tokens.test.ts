import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const kit = read("./tokens.css");
const app = read("../../../apps/web/src/theme.css");

/** Custom properties declared in the first block that starts with `selector {`. */
function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} block missing`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const modes = [
  { name: "light", kit: block(kit, ":root"), app: block(app, ":root") },
  { name: "dark", kit: block(kit, '[data-theme="dark"]'), app: block(app, ".dark") },
];

test("kit tokens match the app's theme.css", () => {
  for (const m of modes) {
    const shared = Object.keys(m.kit).filter((k) => k in m.app);
    assert.ok(shared.length >= 10, `${m.name}: expected the colour tokens to be shared`);
    for (const k of shared) assert.equal(m.kit[k], m.app[k], `${m.name} ${k}`);
  }
  const appRoot = block(app, "@theme");
  for (const k of Object.keys(appRoot).filter((k) => /^--(spacing|radius)-/.test(k))) {
    assert.equal(modes[0].kit[k], appRoot[k], k);
  }
});

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Text on background pairs; 4.5:1 (AA body text).
const pairs: [string, string][] = [
  ["--color-ink", "--color-canvas"],
  ["--color-ink", "--color-surface"],
  ["--color-ink", "--color-surface-muted"],
  ["--color-ink", "--color-control"],
  ["--color-muted", "--color-canvas"],
  ["--color-muted", "--color-surface"],
  ["--color-muted", "--color-surface-muted"],
  ["--color-link", "--color-canvas"],
  ["--color-link", "--color-surface"],
  ["--color-link", "--color-surface-muted"],
  ["--color-accent-fg", "--color-accent"],
];

test("text pairs meet 4.5:1 in light and dark", () => {
  for (const m of modes) {
    const t = { ...modes[0].kit, ...m.kit };
    for (const [fg, bg] of pairs) {
      assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${m.name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    }
  }
});
