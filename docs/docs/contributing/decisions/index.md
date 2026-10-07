---
title: Architecture decisions
description: Short records of the decisions that shape Lifer's architecture, why they were made, and what they cost.
---

# Architecture decisions

An architecture decision record (ADR) is a short note about one decision that shapes the codebase: the situation, what was decided, what else was considered, and what it costs. They're here so that contributors and reviewers can see why Lifer is built the way it is before proposing to change it, and so that the costs are written down next to the benefits.

Each record has the same parts:

- **Status:** Accepted, with the date the decision first appears in the repository's history when there is one.
- **Context:** the problem and the constraints.
- **Decision:** what Lifer does.
- **Alternatives considered:** what else was tried or rejected, where the record shows it.
- **Consequences:** what got better, and what it costs.

Reasons come from code comments, commit messages and docs, or were confirmed by the maintainer where nothing was written down.

The repository's history begins on 2026-08-22, with much of the design already in place, so a date is when a decision first appears in git, not necessarily when it was made. Some recent changes aren't in a release yet; their records say so.

## Records

| # | Decision | Status |
|---|---|---|
| [0001](./0001-postgresql-everywhere.md) | PostgreSQL everywhere, embedded in the desktop app | Accepted, 2026-08-29 |
| [0002](./0002-tauri-shell-with-node-sidecar.md) | A Tauri shell running the Node API as a sidecar | Accepted, 2026-08-27 |
| [0003](./0003-one-api-for-desktop-and-server.md) | One API and web app for desktop and server | Accepted, 2026-08-22 |
| [0004](./0004-species-data-shipped-as-release-assets.md) | Species data built by a maintainer pipeline and shipped as GitHub release files | Accepted, 2026-10-03 (current form) |
| [0005](./0005-catalog-separate-from-user-data.md) | Catalog data kept separate from user data | Accepted, next release |
| [0006](./0006-database-primary-files-carry-recovery-copy.md) | The database is the source of truth; files carry a recoverable copy | Accepted, 2026-09-25 |
| [0007](./0007-library-layout-species-folders.md) | Lifer files photos into species folders | Accepted, 2026-08-29 (current form) |
| [0008](./0008-in-process-onnx-inference.md) | ONNX models run in the API process on a worker thread | Accepted, 2026-10-03 |
| [0009](./0009-compiled-server.md) | The production server is compiled with esbuild | Accepted, next release |
| [0010](./0010-photo-license-policy.md) | Which photo licenses the project redistributes | Accepted, next release (current form) |
| [0011](./0011-typebox-validation-and-generated-openapi.md) | Request validation with TypeBox, and an OpenAPI document generated from it | Accepted, next release |
| [0012](./0012-no-state-management-library.md) | No state-management or data-fetching library in the web app | Accepted, 2026-08-22 |

## Adding a record

Add one when a pull request makes a decision that's expensive to reverse, or reverses an earlier one. Copy an existing record, number it one higher than the highest, and link it here. Don't rewrite an accepted record to change the decision: write a new one and mark the old one **Superseded by** the new number.
