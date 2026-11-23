// The shared baseline of failures the sweeps know about (e2e/known-failures.json). A listed case is
// marked as an expected failure, so it can't fail the run, and passing again forces its entry out.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TestInfo } from "@playwright/test";

export interface KnownFailure {
  /** Spec file name, e.g. "back-navigation.spec.ts". */
  spec: string;
  /** Exact test title. */
  test: string;
  reason: string;
  /** Rule id from docs/plans/ux-rules.md. */
  uxRule: string;
  /** The plan package expected to fix it, e.g. "U-03". */
  fixedBy: string;
}

const FILE = new URL("../known-failures.json", import.meta.url);

export function markKnownFailure(info: TestInfo): void {
  const list = JSON.parse(readFileSync(FILE, "utf8")) as KnownFailure[];
  const spec = path.basename(info.file);
  const hit = list.find((k) => k.spec === spec && k.test === info.title);
  if (hit) info.fail(true, `${hit.uxRule}: ${hit.reason}`);
}
