// A local stand-in for the GitHub release assets the server downloads: the pack index, region
// packs and the catalog manifest. It is also the server's HTTP(S) proxy, so any other outbound
// request is refused here and logged instead of reaching the internet.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import * as tar from "tar";
import { ALL_SPECIES, CATALOG_VERSION, COUNTRY, PROVINCE, TAXA, type FixtureSpecies } from "./fixtureCatalog.js";

interface BuiltPack {
  id: string;
  file: string;
  taxon: string;
  species: FixtureSpecies[];
  contentVersion: string;
}

// One pack per taxon for the fixture country, with its province bundled in, as the real pack
// builder publishes them (packages/data-pipeline build-region-pack.ts).
async function buildPacks(dir: string): Promise<BuiltPack[]> {
  const packs: BuiltPack[] = [];
  for (const taxon of TAXA) {
    const id = `${COUNTRY.name.toLowerCase()}-${taxon}`;
    const work = path.join(dir, id);
    mkdirSync(path.join(work, "photos"), { recursive: true });
    const species = ALL_SPECIES.filter((s) => s.taxonClass === taxon);

    const entries = [];
    for (const [i, s] of species.entries()) {
      let displayFile: string | null = null;
      let thumbFile: string | null = null;
      if (s.hasPhoto) {
        // A plain colour swatch per species: self-made, so no third-party photo is involved.
        const swatch = sharp({
          create: { width: 480, height: 360, channels: 3, background: { r: 60 + i * 50, g: 110, b: 90 } },
        });
        displayFile = `photos/${i}-display.webp`;
        thumbFile = `photos/${i}-thumb.webp`;
        await swatch.clone().webp().toFile(path.join(work, displayFile));
        await swatch.clone().resize(160).webp().toFile(path.join(work, thumbFile));
      }
      entries.push({
        scientificName: s.scientificName,
        habitatDescription: null,
        referenceCredit: s.hasPhoto ? "Lifer e2e fixture" : null,
        referenceLicense: s.hasPhoto ? "CC0" : null,
        displayFile,
        thumbFile,
        localTier: "common",
      });
    }

    const manifest = {
      type: "region",
      region: COUNTRY.name,
      taxon,
      species: entries,
      children: [
        {
          name: PROVINCE.name,
          ebirdRegionCode: PROVINCE.code,
          boundaryGeoJson: null,
          externalCodes: [PROVINCE.code],
          isOverseasTerritory: false,
          species: entries.filter((_, i) => species[i].inProvince),
        },
      ],
    };
    const manifestJson = JSON.stringify(manifest);
    writeFileSync(path.join(work, "manifest.json"), manifestJson);
    const file = path.join(dir, `${id}.pack.tar.gz`);
    await tar.c({ gzip: true, file, cwd: work, portable: true }, ["manifest.json", "photos"]);
    const contentVersion = createHash("sha256").update(manifestJson).digest("hex").slice(0, 16);
    packs.push({ id, file, taxon, species, contentVersion });
  }
  return packs;
}

export interface Mirror {
  close: () => Promise<void>;
  blockedRequests: string[];
}

export async function startMirror(opts: {
  port: number;
  workDir: string;
  log: (line: string) => void;
}): Promise<Mirror> {
  const base = `http://127.0.0.1:${opts.port}`;
  const packs = await buildPacks(opts.workDir);
  const packIndex = {
    generatedAt: new Date().toISOString(),
    packs: packs.map((p) => ({
      id: p.id,
      type: "region",
      region: COUNTRY.name,
      taxon: p.taxon,
      sizeBytes: statSync(p.file).size,
      speciesCount: p.species.length,
      contentVersion: p.contentVersion,
      scientificNames: p.species.map((s) => s.scientificName),
      // Must share the index's origin (assertTrustedPackUrl in apps/api/src/offlinePacks/index.ts).
      url: `${base}/packs/${path.basename(p.file)}`,
    })),
  };
  const catalogManifest = { version: CATALOG_VERSION, publishedAt: "2026-01-01T00:00:00Z" };
  const blockedRequests: string[] = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    // A proxied plain-HTTP request carries an absolute URL; anything not for us is refused.
    if (/^https?:\/\//.test(url) && !url.startsWith(base)) {
      blockedRequests.push(url);
      opts.log(`[e2e mirror] blocked outbound request: ${req.method} ${url}`);
      res.writeHead(403).end();
      return;
    }
    const pathname = new URL(url, base).pathname;
    if (pathname === "/pack-index.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packIndex));
    } else if (pathname === "/catalog-manifest.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(catalogManifest));
    } else if (pathname.startsWith("/packs/") && packs.some((p) => `/packs/${path.basename(p.file)}` === pathname)) {
      const body = readFileSync(path.join(opts.workDir, path.basename(pathname)));
      res.writeHead(200, { "content-type": "application/gzip", "content-length": body.length }).end(body);
    } else {
      opts.log(`[e2e mirror] 404 for ${req.method} ${pathname}`);
      res.writeHead(404).end();
    }
  });
  // HTTPS through the proxy arrives as CONNECT host:443. Refused, so nothing leaves the machine.
  server.on("connect", (req, socket) => {
    blockedRequests.push(`CONNECT ${req.url}`);
    opts.log(`[e2e mirror] blocked outbound request: CONNECT ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  return {
    blockedRequests,
    close: () =>
      new Promise((resolve) => {
        // Keep-alive connections from the API would otherwise hold close() open.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
