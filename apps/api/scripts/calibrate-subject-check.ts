// How the import's "is there an animal" reading (species/wildlifeCheck.ts) does on photos known to
// show an animal, and on photos known not to. Reads only the matching benchmark's cache
// (npm run benchmark-matching -w data-pipeline): each sampled catalog photo's stored CLIP vector
// and the detector's reading of it. Non-animal photos: catalog reference photos the portrait check
// calls habitat, map, drawing or text, plus any image files named with --negatives (comma list).
//
//   npx tsx apps/api/scripts/calibrate-subject-check.ts [--detector=megadetector-v6c-v1] [--negatives=a.jpg,b.jpg]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { classifyReferencePhoto } from "@lifer/core/species/referencePortrait.js";
import { analyzeImage, stopInference } from "@lifer/core/species/inference.js";
import { photoVector } from "@lifer/core/species/vectorCache.js";
import { judgeSubject, subjectPromptVectors, type SubjectCheck } from "../src/species/wildlifeCheck.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: args } = parseArgs({
  options: {
    detector: { type: "string", default: "megadetector-v6c-v1" },
    cache: { type: "string", default: path.join(REPO, "data", "matching-benchmark") },
    negatives: { type: "string", default: "" },
    "proxy-limit": { type: "string", default: "300" },
    // A folder of cached import readings of real animal photos ({ clip, animal } JSON per photo).
    "animal-readings": { type: "string", default: "" },
  },
});
const DIM = 768;
const cache = args.cache!;
const bin = (f: string) => {
  const b = readFileSync(path.join(cache, f));
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const catalog: Array<{ cls: string; gallery: Array<{ photo: string; display: string | null }> }> = JSON.parse(
  readFileSync(path.join(cache, "catalog.json"), "utf8"),
);
const clipMeta: Record<string, { gallery: Record<string, number> }> = JSON.parse(
  readFileSync(path.join(cache, "catalog-clip.json"), "utf8"),
);
const clipData = bin("catalog-clip.bin");
const clipVec = (at: number) => clipData.subarray(at * DIM, at * DIM + DIM);

const photoClass = new Map<string, string>();
const photoDisplay = new Map<string, string | null>();
const photoClip = new Map<string, number>();
for (const s of catalog) {
  for (const g of s.gallery) {
    photoClass.set(g.photo, s.cls);
    photoDisplay.set(g.photo, g.display);
  }
}
for (const c of Object.values(clipMeta)) for (const [photo, at] of Object.entries(c.gallery)) photoClip.set(photo, at);

type Verdict = "sure" | "maybe" | "unsure-only" | "clear";
const verdictOf = (c: SubjectCheck): Verdict =>
  c.notWildlife ? "sure" : c.maybeNotWildlife ? "maybe" : c.animalEvidence === false ? "unsure-only" : "clear";

async function main() {
  const prompts = await subjectPromptVectors();
  const tally = new Map<string, Record<Verdict, number>>();
  const add = (group: string, v: Verdict) => {
    const t = tally.get(group) ?? { sure: 0, maybe: 0, "unsure-only": 0, clear: 0 };
    t[v]++;
    tally.set(group, t);
  };

  // Real animals: every photo the benchmark ran with this detector.
  const runsFile = path.join(cache, `photos-${args.detector}.jsonl`);
  for (const line of readFileSync(runsFile, "utf8").split("\n")) {
    if (!line) continue;
    const run = JSON.parse(line) as { photo: string; animal: number };
    const at = photoClip.get(run.photo);
    if (at == null) continue;
    const presence = { animal: run.animal, person: 0, personArea: 0, count: 0 };
    const check = await judgeSubject(clipVec(at), prompts, async () => presence);
    add(`animal: ${photoClass.get(run.photo)}`, verdictOf(check));
  }

  if (args["animal-readings"]) {
    const dir = args["animal-readings"];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const r = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { clip: number[]; animal: number | null };
      const presence = { animal: r.animal ?? 0, person: 0, personArea: 0, count: 0 };
      add("animal: real photos (given readings)", verdictOf(await judgeSubject(r.clip, prompts, async () => presence)));
    }
  }

  // Not animals: the catalog's habitat shots, maps, drawings and text, and any files given.
  const negatives: Array<{ group: string; vector: Float32Array; file: string | null }> = [];
  for (const [photo, at] of photoClip) {
    const kind = classifyReferencePhoto(clipVec(at)).kind;
    if (!["habitat", "map", "drawing", "text"].includes(kind)) continue;
    const display = photoDisplay.get(photo);
    if (display && existsSync(display))
      negatives.push({ group: `not an animal: ${kind}`, vector: clipVec(at), file: display });
  }
  negatives.splice(Number(args["proxy-limit"]));
  for (const file of args.negatives!.split(",").filter(Boolean))
    negatives.push({
      group: "not an animal: given files",
      vector: await photoVector("clip", { path: file }, { priority: "background" }),
      file,
    });
  for (const n of negatives) {
    const check = await judgeSubject(n.vector, prompts, async () => {
      const r = await analyzeImage({ path: n.file! }, { targets: [], presence: true, priority: "background" });
      return r.presence!;
    });
    add(n.group, verdictOf(check));
  }

  console.log("| Photos | n | Not wildlife (left out) | Maybe (asked) | No confident name | Untouched |");
  console.log("|---|---|---|---|---|---|");
  for (const [g, t] of [...tally].sort()) {
    const n = t.sure + t.maybe + t["unsure-only"] + t.clear;
    const p = (x: number) => `${Math.round((1000 * x) / n) / 10}%`;
    console.log(`| ${g} | ${n} | ${p(t.sure)} | ${p(t.maybe)} | ${p(t["unsure-only"])} | ${p(t.clear)} |`);
  }
  await stopInference();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
