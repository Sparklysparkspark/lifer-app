---
id: 0013-open-gallery-vectors
title: "ADR 0013: Openly licensed gallery vectors"
description: Gallery vectors are tagged with their photo's licence, and the open subset is what Lifer can offer for reuse once matching is shown to hold.
---

# ADR 0013: Openly licensed gallery vectors, tagged per vector

**Status:** Proposed. The tagging is in place; the open-only selection ships only after the measurement below is filled in and matching holds.

## Context

Each gallery photo has one CLIP vector (`species_reference_gallery_embeddings`). Some come from photos under non-commercial or share-alike licences. A vector is not a photo, but its licence and credit should travel with it so the open subset can be told apart and offered for reuse (the open vectors endpoint, L-12).

## Decision

- Migration 174 adds `license`, `photographer` and `source_url` to each gallery vector row, filled from the photo it was computed from. The embeddings step writes them with every new vector.
- Open means CC0, the Public Domain Mark or CC BY (`isOpenVectorLicense` in `licensePolicy.ts`). Share-alike, non-commercial and no-derivatives are not open for this purpose.
- A species keeps up to 6 vectors. Open ones come first; the others only top up a species with fewer than 3 open ones (`chooseGalleryVectors`).
- Gallery vectors stay in the distribution either way.

## Measurement (to fill in before shipping)

Top-1 and top-5 on confirmed GPS captures, current gallery against the open-only selection, per group. Ship the open-only selection only if matching holds.

| Group                   | Captures | Top-1 now | Top-1 open | Top-5 now | Top-5 open |
| ----------------------- | -------- | --------- | ---------- | --------- | ---------- |
| Birds                   |          |           |            |           |            |
| Mammals                 |          |           |            |           |            |
| Reptiles and amphibians |          |           |            |           |            |
| Fish                    |          |           |            |           |            |
| Other                   |          |           |            |           |            |

## Consequences

The run that fetches more open photos and recomputes vectors is long and resumable, and needs the maintainer's go-ahead.
