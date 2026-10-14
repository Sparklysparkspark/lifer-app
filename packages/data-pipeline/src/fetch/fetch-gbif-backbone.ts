// Writes data/build/gbif-backbone-aves.json, the input fetch-wikidata.ts and
// fetch-reference-photos.ts read when run on their own. The fetch itself lives in
// src/gbif/backbone.ts, shared with the seed builders.
//
// Usage: npx tsx src/fetch/fetch-gbif-backbone.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifBackboneAves } from "../gbif/backbone.js";
import { BUILD_DIR } from "@lifer/core/rawCache.js";

const rows = await fetchGbifBackboneAves();
mkdirSync(BUILD_DIR, { recursive: true });
const dest = path.join(BUILD_DIR, "gbif-backbone-aves.json");
writeFileSync(dest, JSON.stringify(rows, null, 2));
console.log(`[gbif] wrote ${rows.length} species to ${dest}`);
