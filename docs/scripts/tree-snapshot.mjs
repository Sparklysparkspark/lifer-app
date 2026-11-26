// Writes the landing page's Tree of life demo data (src/data/treeSnapshot.json) and its hover
// photos (static/img/tree/) from a real collection in the running desktop app: one region's land
// animals. Start the dev app, then from docs/: node scripts/tree-snapshot.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const sharp = createRequire(import.meta.url)("sharp");
const APP = "http://localhost:4310";
const REGION = "90e9899d-3af8-469f-8d51-fbda1c2cb3a3"; // Belize
const CLASSES = {
  aves: "Birds",
  mammalia: "Mammals",
  squamata: "Reptiles",
  testudines: "Turtles",
  amphibia: "Amphibians",
};
const TIERS = ["common", "occasional", "uncommon", "rare", "legendary"];
const IMG = fileURLToPath(new URL("../static/img/tree/", import.meta.url));

let pid = "";
try {
  pid = execFileSync("lsof", ["-tiTCP:4310", "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
} catch {
  throw new Error("Lifer isn't running: start the desktop app first.");
}
const token = execFileSync("ps", ["eww", "-o", "command=", "-p", pid], { encoding: "utf8" }).match(
  /LIFER_LAUNCH_TOKEN=(\S+)/,
)?.[1];
if (!token) throw new Error("Lifer isn't running: start the desktop app first.");
const headers = { "x-lifer-launch-token": token };
const get = async (path) => {
  const res = await fetch(APP + path, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res;
};

const { tree } = await (await get(`/api/collection/tree?include=uncollected&regionId=${REGION}`)).json();

// Only the user's own photos go on the site, never catalogue reference photos (other people's).
const photos = new Set();
const photoOf = (n) => {
  if (!n.collected || !n.photoId) return undefined;
  photos.add(n.photoId);
  return n.photoId.slice(0, 8);
};
const tiersOf = (t) => Object.fromEntries(TIERS.filter((k) => t?.[k]).map((k) => [k, t[k]]));
// The demo's rings are class, order, family, species: genera are skipped.
const speciesUnder = (n) => (n.rank === "species" ? [n] : (n.children ?? []).flatMap(speciesUnder));

const out = tree
  .filter((c) => CLASSES[c.name])
  .map((c) => ({
    name: CLASSES[c.name],
    photo: photoOf(c),
    children: c.children.map((o) => ({
      name: o.name,
      photo: photoOf(o),
      children: o.children.map((f) => ({
        name: f.name,
        photo: photoOf(f),
        children: speciesUnder(f).map((s) => ({
          name: s.commonName ?? s.name,
          latin: s.name,
          collected: s.collected ? 1 : 0,
          targets: s.targetCount ? 1 : 0,
          tiers: tiersOf(s.tiers),
          photo: photoOf(s),
        })),
      })),
    })),
  }));

rmSync(IMG, { recursive: true, force: true });
mkdirSync(IMG, { recursive: true });
// The square each species card shows, cut to the user's crop; a group's cover is one of its species.
const slugOf = new Map();
const walk = (n) => {
  if (n.rank === "species" && n.collected && n.photoId && !slugOf.has(n.photoId))
    slugOf.set(n.photoId, n.name.replace(/[^A-Za-z0-9-]/g, "_"));
  (n.children ?? []).forEach(walk);
};
tree.forEach(walk);
for (const id of photos) {
  const slug = slugOf.get(id);
  const path = slug ? `/api/companion/v1/square/species/${slug}?photo=${id}` : `/api/photos/${id}/thumb`;
  const buf = Buffer.from(await (await get(path)).arrayBuffer());
  await sharp(buf)
    .resize(320, 320, { fit: "cover" })
    .jpeg({ quality: 72 })
    .toFile(`${IMG}${id.slice(0, 8)}.jpg`);
  // The whole frame, for the panel beside the circle.
  const display = Buffer.from(await (await get(`/api/photos/${id}/display`)).arrayBuffer());
  await sharp(display)
    .resize(640, 640, { fit: "inside" })
    .jpeg({ quality: 72 })
    .toFile(`${IMG}${id.slice(0, 8)}-wide.jpg`);
}
writeFileSync(new URL("../src/data/treeSnapshot.json", import.meta.url), JSON.stringify(out) + "\n");
console.log(`${out.length} classes, ${photos.size} photos`);
