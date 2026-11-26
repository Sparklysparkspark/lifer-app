// Smart tags labelling page (docs/plans/smart-tags.md, ST-0): a local page for labelling a folder
// of photo copies with the vocabulary's terms. Reads the photos folder, never writes to it, never
// uploads; labels go to one TSV that calibrate-smart-tags reads. Serves on 127.0.0.1 only.
//
//   npm run label-smart-tags -w data-pipeline -- --photos=<folder> --labels=<scratch>/labels.tsv
//
//   --photos  folder of JPEG, PNG, WebP, TIFF or AVIF copies (searched recursively; read only)
//   --labels  the labels TSV to create or continue (must be outside the photos folder)
//   --vocab   vocabulary JSON (default packages/shared/src/smartTags/vocab.json)
//   --port    default 5199
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { clipTerms, formatLabels, type LabelRow, parseLabels, parseVocabulary } from "../smartTags/calibration.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const resolveArg = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
const IMAGE = /\.(jpe?g|png|webp|tiff?|avif)$/i;

function walk(dir: string, root: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full, root);
      return IMAGE.test(e.name) ? [path.relative(root, full).split(path.sep).join("/")] : [];
    })
    .sort();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Capture time as local "YYYY-MM-DDTHH:MM:SS". */
async function takenAt(file: string): Promise<string> {
  try {
    const { exif } = await sharp(file).metadata();
    // shortcut: earliest EXIF timestamp string (DateTimeOriginal is never later than DateTime);
    // switch to a real EXIF parser if exported copies show wrong dates.
    const stamps = [...(exif?.toString("latin1") ?? "").matchAll(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/g)]
      .filter((m) => m[1] !== "0000")
      .map((m) => `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
      .sort();
    if (stamps[0]) return stamps[0];
  } catch {
    // Unreadable metadata: fall back to the file time.
  }
  const d = statSync(file).mtime;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      photos: { type: "string" },
      labels: { type: "string" },
      vocab: { type: "string" },
      port: { type: "string", default: "5199" },
    },
  });
  if (!values.photos || !values.labels) throw new Error("--photos=<folder> and --labels=<file> are required");
  const photosDir = resolveArg(values.photos);
  const labelsFile = resolveArg(values.labels);
  const rel = path.relative(photosDir, labelsFile);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("--labels must be outside the photos folder");
  const vocabFile = values.vocab
    ? resolveArg(values.vocab)
    : path.join(REPO_ROOT, "packages/shared/src/smartTags/vocab.json");
  const terms = clipTerms(parseVocabulary(JSON.parse(readFileSync(vocabFile, "utf8"))));
  const termIds = new Set(terms.map((t) => t.id));

  const photos = walk(photosDir, photosDir);
  if (photos.length === 0) throw new Error(`No photos found in ${photosDir}`);
  console.log(`[label-smart-tags] reading capture times of ${photos.length} photos`);
  const taken = new Map<string, string>();
  for (const p of photos) taken.set(p, await takenAt(path.join(photosDir, p)));
  const saved = new Map<string, LabelRow>();
  if (existsSync(labelsFile)) for (const r of parseLabels(readFileSync(labelsFile, "utf8"))) saved.set(r.photo, r);

  const save = () => {
    const tmp = `${labelsFile}.tmp`;
    writeFileSync(tmp, formatLabels(photos.flatMap((p) => saved.get(p) ?? [])));
    renameSync(tmp, labelsFile);
  };

  const page = readFileSync(path.join(HERE, "../smartTags/label-page.html"), "utf8");
  const state = () => ({
    terms: terms.map(({ id, label, facet, description }) => ({ id, label, facet, description })),
    photos: photos.map((p) => {
      const folder = path.posix.dirname(p) === "." ? path.basename(photosDir) : path.posix.dirname(p);
      const r = saved.get(p);
      return {
        photo: p,
        taken: taken.get(p),
        session: r?.session ?? `${taken.get(p)!.slice(0, 10)} ${folder}`,
        present: r?.present ?? [],
        labelled: !!r,
        skipped: !!r && r.present.length === 0 && r.absent !== "*",
      };
    }),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      } else if (req.method === "GET" && url.pathname === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state()));
      } else if (req.method === "GET" && url.pathname.startsWith("/img/")) {
        // By index, never by path, so nothing outside the photo list can be served.
        const p = photos[Number(url.pathname.slice(5))];
        if (!p) return void res.writeHead(404).end();
        const jpeg = await sharp(path.join(photosDir, p))
          .rotate()
          .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=3600" }).end(jpeg);
      } else if (req.method === "POST" && url.pathname === "/api/label") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const b = JSON.parse(body) as { photo?: unknown; session?: unknown; present?: unknown; skip?: unknown };
        if (typeof b.photo !== "string" || !taken.has(b.photo)) return void res.writeHead(400).end("unknown photo");
        const session = typeof b.session === "string" && b.session.trim() ? b.session.trim() : null;
        if (!session) return void res.writeHead(400).end("session is required");
        const present = Array.isArray(b.present)
          ? b.present.filter((t): t is string => typeof t === "string" && termIds.has(t))
          : [];
        saved.set(b.photo, {
          photo: b.photo,
          session,
          taken: taken.get(b.photo)!,
          present: b.skip ? [] : present,
          // Every term not ticked is absent; a skipped photo is labelled for nothing.
          absent: b.skip ? [] : "*",
        });
        save();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ labelled: saved.size }));
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end((err as Error).message);
    }
  });
  server.listen(Number(values.port), "127.0.0.1", () => {
    console.log(
      `[label-smart-tags] ${photos.length} photos, ${saved.size} labelled. Open http://127.0.0.1:${values.port}`,
    );
    console.log(`[label-smart-tags] labels are saved to ${labelsFile} after every photo; Ctrl+C to stop`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
