-- A pure informational badge, same spirit as endemic_country_iso3 — never excludes a species
-- from anywhere by itself. A species can be extinct in the wild AND still be a real,
-- legitimate, physically findable target via active reintroduction (Spix's Macaw, for
-- example) — this flag is context to show alongside "endemic," not a removal trigger.
-- (Beloribitsa/Stenodus leucichthys is the case that surfaced the need for this: extinct in
-- the wild in its native Caspian range, but showing up in Canadian GBIF records via
-- misidentified sheefish.)
ALTER TABLE species_traits ADD COLUMN extinct_in_wild boolean NOT NULL DEFAULT false;
