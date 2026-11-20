---
title: Release personas
description: Exploratory passes before each release, as four kinds of user, plus the bad-file checks that can't be automated.
---

# Release personas

Automated tests check what we thought of. Before each release, walk the app as four people who'd use it differently, and file what breaks. A pass can be run by you or by an agent with a browser; either way it ends in screenshots and filed findings.

Run every pass on the release build, not a dev server. Do at least one persona on Windows and one on Linux each release, not only macOS.

## How to run a pass

1. Set up the persona's starting state (below).
2. Walk the steps in order. Don't follow the docs unless the persona would; stop and note where you'd reach for them.
3. Screenshot every page you land on in light and dark, at the smallest window and at full screen. For server pages add phone width. `npm run screens -- --seeds=extreme` takes the standard set of pages for the seeded libraries.
4. Note each finding as you go: page, what you did, what happened, what you expected, screenshot.
5. File findings (see [Filing findings](#filing)).

## New user

Never used Lifer, has a folder of phone and camera photos.

- **Setup:** fresh install, no account, no regions downloaded.
- **Walk:** first run and onboarding; import a folder of 30 photos with a few RAWs and one video; confirm the suggested species; open the Collection and a species; search the Gallery for `bird flying`; make an album; delete a photo and restore it from the Trash; close and reopen the app.
- **Watch for:** words a newcomer wouldn't know, a page with no way forward, waits with no progress, anything asked twice.

## Lightroom user

Has years of photos in a Lightroom Classic catalogue and expects Lightroom's keys.

- **Setup:** fresh install, a small Lightroom catalogue with keywords, ratings and collections, and its photo folders.
- **Walk:** import from the catalogue; check ratings, keywords and dates came across; install the plugin from the [Lightroom guide](../guides/lightroom.md) and tag a photo from Lightroom; use the shortcuts Lightroom users try first (number keys to rate, arrow keys, <kbd>G</kbd>, <kbd>E</kbd>); add photos to the library folder and see them picked up; open a photo in an outside editor and come back.
- **Watch for:** lost metadata, a shortcut that does something surprising, any change made to the catalogue or the original files.

## Server owner

Runs Lifer in Docker on a NAS and uses it from a desktop app and a phone browser.

- **Setup:** a new server from the [Docker guide](../install/docker.md) with no environment variables set, then a desktop app [connected to it](../install/connect-desktop-to-server.md).
- **Walk:** create the account; download a region; import from the desktop app; make an album on the desktop and see it on the server, and the other way round; delete it on one side and see it go on the other; stop the server, keep working on the desktop, start it again; make a share link and open it signed out on a phone; restart the container and check nothing is lost.
- **Watch for:** anything that needs a setting or env var to work, sync that doesn't arrive or comes back after a delete, pages that break at phone width.

## Birder with 200,000 photos

Ten years of photos, thousands of species, long trip names, every edge case.

- **Setup:** the extreme seed in `e2e/support/extremeLibrary.ts` (5,000 species, 60,000 photos, 300-character names, a 50-state country, 1,000 albums, 500 trips, missing files). Load it into `lifer_test` with `npm run seed:extreme`, then start the API on that database as the file's header says. Never point it at the `lifer` database.
- **Walk:** scroll the Collection and Gallery end to end; switch pages quickly; filter by several regions and a rating range; open the biggest album and trip; select all in the Gallery and cancel; open Stats; search for a 300-character name; go back after each step and check you land where you were.
- **Watch for:** slow pages (more than a moment to show), text overflowing its box, counts that don't add up between pages, scroll position lost on back.

## Filing findings {#filing}

- One finding, one entry. Group by persona.
- Each one gets: the page, steps, what happened, what was expected, the screenshot path, the system (Windows, macOS, Linux or server), and the UX rule it breaks from `docs/plans/ux-rules.md` if there is one.
- The maintainer turns them into packages in the implementation plan. A finding that blocks a persona's walk blocks the release.

## Bad files {#bad-files}

`e2e/tests/bad-files.spec.ts` imports the files in `e2e/fixtures/bad-files/` (a corrupt JPEG, a zero-byte file, a file with the wrong extension and a truncated file) and checks each gives a plain message while the rest of the import goes on. It runs with the other e2e tests.

These need a person, on each system, before each release:

- [ ] **Locked file (Windows):** open a photo in another app that locks it (for example, keep it open for editing), then import its folder. The locked photo gets a plain message and the rest import.
- [ ] **File removed mid-import:** start importing a large folder and delete or move one file that hasn't been read yet. That file gets a plain message, the import finishes, and nothing else is lost.
- [ ] **Drive unplugged mid-import:** import from a USB drive and unplug it partway. The import stops with a plain message, and what was already imported stays.
