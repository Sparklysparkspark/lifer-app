import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTokens } from "./export-design-tokens.mjs";

const css = `:root { --color-ink: #111111; }
.dark { --color-ink: #eeeeee; }
@theme { --spacing-page: 1.5rem; --radius-panel: 0.75rem; --text-body: 1rem; --text-body--line-height: calc(1.25 / 0.5); }`;

test("colours, rem sizes and calc line heights convert", () => {
  const t = buildTokens(css);
  assert.deepEqual(t.light, { ink: "#111111" });
  assert.deepEqual(t.dark, { ink: "#eeeeee" });
  assert.equal(t.spacing.page, 24);
  assert.equal(t.radius.panel, 12);
  assert.deepEqual(t.type.body, { size: 16, lineHeight: 2.5 });
});

test("a missing block is an error", () => {
  assert.throws(() => buildTokens(":root { --color-ink: #111; }"), /no @theme block/);
});
