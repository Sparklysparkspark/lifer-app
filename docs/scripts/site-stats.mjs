// Writes src/data/siteStats.json, the landing page's counters, from the species catalogue.
// Run from docs/: node scripts/site-stats.mjs. Read-only SELECTs through psql, or the Docker
// database's own psql when there is none: PSQL="docker exec lifer-app-postgres-1 psql -U lifer -d lifer".
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [cmd, ...args] = (process.env.PSQL ?? `psql ${process.env.DATABASE_URL ?? ""}`).trim().split(/\s+/);
const q = (sql) => Number(execFileSync(cmd, [...args, "-Atc", sql], { encoding: "utf8" }).trim());

const onChecklist = `exists (select 1 from region_species r where r.species_id = s.id)
  or exists (select 1 from sea_zone_species z where z.species_id = s.id)`;
// Countries are the third level of World > continent > country.
const countries = `select count(*) from regions c join regions p on p.id = c.parent_id
  where p.parent_id = (select id from regions where parent_id is null)
  and exists (select 1 from region_species r where r.region_id = c.id)`;

const stats = {
  date: new Date().toISOString().slice(0, 10),
  species: q(`select count(*) from species s where ${onChecklist}`),
  countries: q(countries),
  oceanAreas: q(
    `select count(*) from sea_zones z where exists (select 1 from sea_zone_species s where s.sea_zone_id = z.id)`,
  ),
  // Species anyone has observed on iNaturalist, all addable in Lifer; rounded down so the
  // page never overstates it between runs.
  inatSpecies: await fetch("https://api.inaturalist.org/v1/observations/species_counts?per_page=0&verifiable=true")
    .then((r) => r.json())
    .then((j) => Math.floor(j.total_results / 10_000) * 10_000),
};
writeFileSync(new URL("../src/data/siteStats.json", import.meta.url), JSON.stringify(stats, null, 2) + "\n");
console.log(stats);
