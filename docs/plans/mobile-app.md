# Lifer mobile app (idea, not committed)

Collected 2026-10-22. Nothing here is decided until the maintainer says so. The likely timing is after
the desktop 1.0.

## What it is

A companion and field app for the archive, not the whole archive.

- **On the phone:**
  - browse the collection, gallery, trips, albums and species pages
  - search
  - edit tags, species and targets
  - mark species as seen
  - identify photos
  - upload phone photos
  - iNaturalist upload
  - an offline copy of whatever the user chooses to keep
- **Stays on desktop or server:** RAW import, full recognition runs over the archive, region pack
  downloads, archive health and other heavy jobs. The phone asks for them.

## What people ask for (from `mobile-app-research.md`)

In order of frequency:
1. Offline access to my own photos and albums while travelling.
2. "Have I seen or photographed this species?" in the field.
3. A life list illustrated with my own photos.
4. Showing my best shots to someone, fast, even if the server is slow or unreachable.
5. Search of the whole archive by species or keyword.
6. Targets near me that I haven't seen yet.
7. Fast browsing from thumbnails cached on the phone.
8. Adding phone, digiscope or back-of-camera shots to the right place without backing up the whole
   camera roll.
9. Separate "seen" and "photographed" lists, with a "still need a photo" marker.
10. Comparing a new sighting with my past photos.

Don't wants: subscriptions or storage fees, forced upload of everything, gamification and badges, leaked
locations, and an app that breaks when the server can't be reached. Rating photos on a phone comes up
rarely and opinion on it is mixed, so it isn't a headline feature.

Design consequences:
- A "showcase" set (best photo per species and favourites) is always kept on the phone at full screen
  quality, so showing someone a shot never waits on the network.
- Thumbnails of the whole library are cached on the phone, with a storage cap the user sets.
- Adding phone photos is per photo, never a camera-roll backup.
- Location is stripped from anything shared, and always for sensitive species.

## How it connects

- **Desktop only (no server needed):**
  - pair once by scanning a QR code in desktop Settings; this uses the sync key from
    `desktop-server-sync.md`
  - on the same Wi-Fi, phone and desktop find each other and sync both ways
  - a menu bar or tray helper keeps sync working while the window is closed
  - away from home, the phone works offline and queues changes
- **With a server:** sync from anywhere with signal.
- **Later options:**
  - working over Tailscale for remote access to the desktop
  - a sync bundle in the user's own iCloud Drive or Dropbox

## What it carries offline

- life list, targets and seen list
- checklists for the regions picked before a trip
- favourite photos
- a small species ID model

## Mobile-first interface

The desktop interface must not be squeezed onto a phone. The mobile interface is designed for the
phone:

- Bottom tab bar, five tabs at most:
  - Home, a "today" view with targets near here, recent photos and trip progress
  - Life list
  - Identify
  - Trips
  - Search
- One-handed: primary actions in thumb reach, 44 pt minimum touch targets, bottom sheets instead of
  centred modals, swipe between photos, pull to refresh, long-press for actions.
- Native conventions per platform (iOS HIG and Material), system share sheet, photo picker and
  haptics.
- Offline state always visible and calm: what's on the phone, what's waiting to sync.
- Field use: big type, works in sunlight (high contrast) and with gloves, fast to the "is this a
  lifer?" answer.
- The same design tokens, voice and rules as desktop (`ux-rules.md`), plus mobile rules for touch,
  reach and offline.

## Technology (recommendation)

React Native (Expo) for the mobile interface, sharing the TypeScript logic with web and desktop:
`packages/core`, API types, i18n strings and design tokens. Native navigation, gestures, camera roll
access, background sync and on-device SQLite are first-class there. Tauri's mobile support (a web view)
would reuse more UI code, but the UI is being redesigned anyway and a web view feels less native on a
phone. Decide with a small prototype of both.

## Positioning and naming

- Two existing mobile birding apps are called Lifer: getlifer.app (UK, ID and collectible cards) and
  liferbirding.com (Australia, a birding game).
- Stay clearly an archive companion: no cards, points, badges or leaderboards.
- Frame identification as "identify the photos you took", not a live point-and-collect camera.
- Store name "Lifer Wildlife Archive".
- Check the UK IPO, USPTO and EUIPO registers before any store submission.

## Licence

App Store terms conflict with the AGPL. Add an App Store exception (AGPL section 7 additional
permission) while the maintainer is the only author, and have contributors accept it (sign-off or a
CLA). The code stays open source. Have a lawyer check the wording.

## Accounts and signing

One Apple Developer account ($99 a year) signs and notarizes the desktop app too. Google Play is a $25
one-time fee. The seller name shown in the stores is the account's legal name (personal or company).
