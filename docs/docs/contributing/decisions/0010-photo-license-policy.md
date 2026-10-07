---
id: 0010-photo-license-policy
title: "ADR 0010: Photo license policy"
description: Which reference photo licenses Lifer redistributes in its published data, and what happens to the rest.
---

# ADR 0010: Which photo licenses the project redistributes

**Status:** Accepted. A license allowlist has existed since 2026-08-22 (`ca4d1cd`); the current publishable set is in the next release.

## Context

Reference photos come from iNaturalist and Wikimedia Commons under many licenses. Lifer redistributes the ones in its published data (packs, the photo store, the catalog seed), and separately shows photos to a user on their own install for personal viewing.

## Decision

`packages/core/src/species/licensePolicy.ts` defines two policies:

- **What the project publishes** (`isPublishableLicense`): CC0, the Public Domain Mark, and every Creative Commons BY license, including NC and ND. Never "all rights reserved", no license, or GFDL. It's "Fixed by policy": the development variable `LIFER_ALLOW_NONCOMMERCIAL_PHOTOS` never changes what's published. The publish step refuses non-publishable photos (`assertPhotosPublishable` in `build-catalog-seed.ts`).
- **What the pipeline's photo fetchers take by default** (`isLicenseAllowed`): commercial-safe licenses (CC0, CC BY, CC BY-SA), widened by `LIFER_ALLOW_NONCOMMERCIAL_PHOTOS=1` for local development.

The reasoning is recorded in `licensePolicy.ts`: "Lifer is free and non-commercial and keeps every photo's credit and license, which is what the NC licenses ask. No-derivatives photos are included too: Lifer only resizes them and converts them to WebP, which CC 4.0 (section 2(a)(4)) counts as a technical modification, never an adaptation". GFDL is excluded because its terms "need the full license text alongside". Anyone reusing the data commercially has to drop the NC photos, which `THIRD_PARTY_NOTICES.md` says.

A species whose only photo can't be published ships without it, marked `photo_withheld`, and each install fetches that photo from iNaturalist for personal viewing ([State and sync](../state-and-sync.md#the-photo-store-and-withheld-photos)). The license code is always stored with a photo, so "tightening later is a filter, not a re-fetch".

## Alternatives considered

- **Commercial-safe only** (CC0, CC BY, CC BY-SA): the original policy. Many species have no such photo.
- **Excluding no-derivatives licenses:** rejected on the reading of CC 4.0 above.

## Consequences

Positive:

- Far more species have a photo in the published data than under a commercial-safe policy.
- Every photo keeps its credit and license through the pipeline and on install.

Negative:

- **The published data isn't usable commercially as a whole**; reusers must filter NC photos.
- **The ND reading is an interpretation of CC 4.0**, and older CC versions' wording differs; it hasn't had legal review.
- Withheld photos are fetched live from iNaturalist by every install that needs them, which is the kind of traffic [ADR 0004](./0004-species-data-shipped-as-release-assets.md) otherwise avoids. Users can turn it off.
- `packages/data-pipeline/DATA_SOURCES.md` still describes the publishable set without ND licenses; it needs updating to match the code.
