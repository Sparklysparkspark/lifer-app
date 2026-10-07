---
title: Roadmap
description: Where Lifer is headed, and how to follow and shape what comes next.
---

# Roadmap

Lifer is in beta. The goal is a stable **1.0** release: dependable updates, a settled database, and features that won't change under you.

## Coming next

These are already planned and mentioned elsewhere in the docs:

- **Sending observations to iNaturalist.** Link your iNaturalist account and send your photos there as draft observations, with the species, date, location and photos filled in. See [iNaturalist](./guides/inaturalist.md#observations).
- **A signed Windows installer**, through [SignPath Foundation](https://signpath.org)'s free code signing for open source projects, so Windows stops warning that Lifer is from an unknown publisher.
- **A TrueNAS catalog app**, after 1.0. Until then, TrueNAS users can run Lifer as a Custom App from `docker-compose.yml`. See [Install with Docker](./install/docker.md).

## Being explored

Ideas we're looking into, with no promise they'll ship or what shape they'll take:

- **Built-in culling (exploring).** An optional review during import that groups photos into encounters (bursts of the same species close together in time), so you can mark each frame **Keep**, **Maybe** or **Reject**. It would offer quality hints from the detection Lifer already does, like whether the animal is in the frame and in focus. It would complement the dedicated culling apps rather than replace them: Lifer already reads their picks and rejects at import. See [Culling with other apps](./guides/culling-with-other-apps.md).
- **More languages.** Lifer is English-only for now. Part of the groundwork is in place: interface text is being moved into one translation file, dates and numbers follow your language, and species names and scientific names are kept out of interface translations. Next would be community translation through Weblate, plus downloadable per-language species names and descriptions. See [Translating Lifer](./contributing/translating.md).

What's been done but not yet released is in the `[Unreleased]` section of the [changelog](https://github.com/Sparklysparkspark/lifer-app/blob/main/CHANGELOG.md).

## Shape what comes next

- Ideas and feature requests start in [Discussions: Ideas](https://github.com/Sparklysparkspark/lifer-app/discussions). Upvote the ones you'd use.
- Work that's been agreed on is tracked in [Issues](https://github.com/Sparklysparkspark/lifer-app/issues).
- Want to build something yourself? See [Development setup](./contributing/development.md), and open a discussion first for anything big.

There are no dates. Lifer is built by volunteers, and a release ships when it's ready.
