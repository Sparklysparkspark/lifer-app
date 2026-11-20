import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const partners = JSON.parse(readFileSync(new URL("./partnerApps.json", import.meta.url), "utf8"));

test("partner apps have plain https URLs", () => {
  assert.ok(Array.isArray(partners));
  for (const p of partners) {
    const u = new URL(p.url);
    assert.equal(u.protocol, "https:", p.name);
    assert.equal(u.search + u.hash, "", `${p.name}: no query string or fragment`);
    for (const k of ["name", "description", "logo", "logoDark"]) assert.ok(p[k], `${p.name} ${k}`);
  }
});
