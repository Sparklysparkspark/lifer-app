---
id: 0004-species-data-shipped-as-release-assets
title: "ADR 0004: Species data shipped as release files"
description: The species catalog, region packs and reference photos are built by a maintainer pipeline and published as GitHub release files, not fetched live by every install.
---

# ADR 0004: Species data built by a maintainer pipeline and shipped as GitHub release files

**Status:** Accepted. Packs have been downloaded from GitHub releases since 2026-08-27 (`09c2547`) and the catalog seed since 2026-08-29 (`cf8b3ca`). The current form, packs as byte ranges in shared shard files plus a single photo store, dates from 2026-10-03 (`0a207f0`).

## Context

Lifer needs, for every region in the world, which species occur there, how common they are, and reference photos and vectors for identification. Building that takes days of GBIF downloads, about 200 GB of disk and a GPU ([Rebuilding the data](../rebuilding-data.md)). Earlier, opening a species page could "fire a live call to iNaturalist/Wikipedia" (`cac51a3`), and the desktop build "is supposed to work fully offline off downloaded packs alone" (same commit). Lifer has no server of its own ([Privacy](../../privacy.md)).

## Decision

The maintainer runs the [data pipeline](../data-pipeline.md) and publishes its output as GitHub release files: the catalog seed (`catalog-latest`), region packs (`packs-latest`), the reference photo store (`photos-latest`), the map and the models. Installs download only what they need, check it, and apply it locally ([State and sync](../state-and-sync.md)).

Packs are byte ranges inside a few large shard files, listed in `pack-index.json`, and each reference photo is stored once in the photo store and fetched by range. The reasons are in the code:

- `packages/data-pipeline/src/pipeline/packStore.ts`: one asset per pack "would hit GitHub's upload rate limit and 1,000-asset-per-release cap".
- `photoStore.ts`: photos are "stored once instead of once per pack, since widespread species would otherwise be copied into hundreds of packs", and installs fetch them "by byte range (GitHub serves release files with Range support)".

## Alternatives considered

- **Live calls to iNaturalist, GBIF and Wikipedia from every install:** the earlier behaviour for enrichment. Kept only as a fallback for species and places not covered by packs, and for photos that can't be redistributed ([ADR 0010](./0010-photo-license-policy.md)).
- **One release file per pack**, then **one release per continent** (`b235dff`: "GitHub caps a release at 1000 assets, which packs-latest was about to hit"), then shards.
- **A hosted Lifer service** that installs query for species data: rejected. Static release files need no server to run or pay for; installs keep working offline once they have the data; and because there's no Lifer service, installs have nothing of Lifer's to contact, so nobody on the project's side sees what any install looks up ([Privacy](../../privacy.md)).

## Consequences

Positive:

- Installs work offline once they have the data; the Docker image and the desktop installer bundle the catalog seed, so even a first start works without internet.
- Third-party services see one maintainer pipeline run a quarter, not every install's page views, and their rate limits apply once.
- Data is reviewed before it ships: the publish gate refuses a build that fails its checks ([Data pipeline](../data-pipeline.md#the-publish-gate)).
- Installs verify downloads: the seed against the manifest's SHA-256, each pack against the index's SHA-256, each photo against its SHA-1, and pack URLs must share the index's origin.

Negative:

- **Freshness depends on the maintainer.** Taxonomy changes reach installs only when someone runs and publishes a refresh, roughly quarterly.
- **A single point of failure:** releases live in one GitHub repository. Forks can publish their own ([Rebuilding the data](../rebuilding-data.md#point-your-fork-at-itself)), but every install defaults to upstream.
- **GitHub's limits shape the format:** 2 GB per asset (`MAX_SHARD_BYTES` is 1.5 GB), 1,000 assets per release, and an installer size budget that caps the bundled seed (the 400 MB guard in `build-catalog-seed.ts`, raised in `b23f8a0`).
- Publishing needs ordering discipline (photo shards, then the index, then the seed and the manifest last) so installs never point at a missing file, and garbage collection of unused shards.
- Rebuilding the data from scratch is a multi-day job, which raises the bar for anyone but the maintainer.
