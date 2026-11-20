import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chownCommand, upCommand } from "./selfHostingCommands.ts";

const guide = readFileSync(new URL("../../docs/install/docker.md", import.meta.url), "utf8");

test("self-hosting page commands appear in the Docker guide", () => {
  for (const c of [chownCommand, upCommand]) assert.ok(guide.includes(c), c);
});
