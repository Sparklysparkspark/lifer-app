---
title: Translating Lifer
description: How Lifer's interface text is organised for translation, what's done, and what's planned.
---

# Translating Lifer

Lifer is English-only for now. More languages are on the [roadmap](../roadmap.md), and part of the groundwork is already in the web app. This page describes that groundwork for contributors. It isn't open for translations yet.

## What's in place

- **One file of interface text.** The web app's strings live in `apps/web/src/locales/en.json`, keyed by area (`gallery.filters.hidden`, `onboarding.pack.title`). Components call `t("key")` from `react-i18next`; plain modules call `i18n.t("key")` when the text is shown, never at module load. About half of the web app has been moved over so far; the rest still has its English inline.
- **ICU messages.** Plurals and placeholders use ICU syntax, for example `{count, plural, one {# photo} other {# photos}}`, so each language can use its own plural forms.
- **Notes for translators.** `apps/web/src/i18n/en.context.json` has the same shape as `en.json`, and explains strings whose meaning isn't obvious from the text alone.
- **Dates and numbers** go through the helpers in `apps/web/src/lib/format.ts`, which follow the active language.
- **API errors** are shown by their `code`, through `apps/web/src/lib/apiErrors.ts`, with the server's English message as the fallback.
- **Species names are data, not interface text.** Common names come from the species catalog, and scientific names are never translated. `useSpeciesName()` in `apps/web/src/lib/speciesName.ts` is the single place a page asks for a species' display name, so a later per-language name pack only has to change that hook.
- **A pseudo-locale for layout testing.** Development builds offer "en-XA" in Settings > General, which accents and lengthens every converted string, so text that would overflow in a longer language shows up early.

## Checks

`npm run check:i18n` runs in CI. It fails when code uses a key that isn't in `en.json`, when `en.json` has a key nothing uses, when a key is built at runtime (keys must be string literals somewhere in the source), or when a message isn't valid ICU.

The ESLint rule that flags hard-coded strings in JSX (`i18next/no-literal-string`) is configured in `eslint.config.mjs` but switched off until the rest of the web app has been moved to `en.json`.

## Writing interface text

- Put new strings in `en.json` and use `t()`, even though only English ships for now. It keeps the remaining work from growing.
- Write whole sentences as one message. Don't build a sentence from fragments, because word order differs between languages.
- Keep the English exactly as it renders. The end-to-end tests match on visible text and accessible names.

## Glossary

Terms with a specific meaning in Lifer, for whoever translates later:

| Term | Meaning |
|---|---|
| Lifer | The app's name. Never translated. Lowercase "lifer" is a birding term: a species seen for the first time. |
| Life list | Every species a person has seen. |
| Checklist | A region's list of species. |
| Encounter | A group of photos of one species taken close together in time. |
| Offline pack | A downloadable bundle of a region's checklist and reference photos. |
| Sidecar | An `.xmp` file next to a RAW photo that holds its metadata. |

## What's planned

- Finish moving the web app's text into `en.json`, then switch the lint rule back on.
- Community translation through a hosted [Weblate](https://weblate.org) project, with `en.json` as the source and one file per language in `apps/web/src/locales/`. Draft machine translations, if used, would be imported marked "needs editing" so a person reviews each one.
- Per-language species names and descriptions, downloaded as packs alongside the species catalog, falling back to English.
