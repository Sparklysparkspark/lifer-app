# Named places

Status: plan, for approval. Written 2026-11-04. Prefix `PLACE-`. Format follows
[lifer-1.0-implementation-plan.md](./lifer-1.0-implementation-plan.md). Read [ux-rules.md](./ux-rules.md),
[map-location-ux.md](./map-location-ux.md) (MAP-07 to MAP-12) and the saved spots code first.

## The ask, in one paragraph

Name a spot once ("King Fisher Pond"), place the pin once, and Lifer works out the locality ("Prince
George, British Columbia, Canada") itself. After that, a photo that needs a location takes it from a drop-down
of your places, so sending to iNaturalist never means opening iNaturalist's map. Lifer also looks at
where your iNaturalist observations already cluster and suggests places to name ("Cottonwood Park").

## What already exists, and what is missing

Saved spots (migration 168, `apps/api/src/places/savedSpots.ts`) already do most of this. Each spot has a
name, a point, a region, a geoprivacy value and sync tracking. Applying a spot runs the shared location job
with Undo (`captures/locationHistory.ts`). The nearby suggestion offers a spot to photos within 150 m.
`/places/locate` already searches spots and regions, and `PlaceSearch.tsx` shows the results. Sending
already builds `place_guess` from the label plus the region, and takes geoprivacy from the spot.

Gaps found while reading the code (each one is fixed below):

1. **Geoprivacy is matched by label text** (`geoprivacyForLabel`, `lower(name)`). Spots are shortcuts by
   design, so renaming a spot leaves its photos on the old label. Their next send goes out **open**. That is a
   silent privacy downgrade, and the most important fix in this plan.
2. **Camera GPS can't be told apart from a placed point.** `location_source` is NULL for camera GPS, map
   placing, spots and Lightroom imports alike. So "never replace camera GPS silently" can't be enforced yet.
3. **No accuracy is sent.** `DraftObservation` has no `positional_accuracy`, so a spot centre reaches
   iNaturalist as if it were an exact point.
4. **No locality and no radius.** A spot only knows its region (a province), not the nearest town.
5. **The picker needs typing.** `PlaceSearch` returns nothing until you type, and sorts by name, not by
   distance.

## Key decisions

1. **Saved spots are the one concept.** No parallel table. The UI keeps calling them "places" (the Places
   page already does). The table gains a radius, a locality, a source and notes.
2. **Locality is worked out once, offline, and stored with its source.** The user can edit it. Coordinates
   are never sent anywhere to do this (no online reverse geocoding, matching MAP-09).
3. **Choosing a place files photos under it, and never moves camera GPS without asking.** Photos with their
   own point keep it and get the name and region only. Photos without a point take the place's centre,
   marked `location_source = 'spot'`, with the place's radius as their accuracy.
4. **A send carries the place's privacy from the place itself, never weaker.** Lifer finds the place by
   label or by the point falling inside its radius, and the strictest match wins. For obscured or private
   places, `place_guess` is the locality only, never the user's name for the spot.
5. **Suggestions are deterministic grid-hash single-link clusters** of the user's own iNaturalist points
   (200 m link, 1 km spread cap, at least 3 observations on at least 2 days). Each one takes the strictest
   privacy among its observations, and a dismissed suggestion never comes back.

## 1. The data: saved spots, extended

A named place holds:

| Field | Column | Notes |
| --- | --- | --- |
| Name | `name` (exists) | Up to 500 characters, unique per user, case-insensitive. |
| Centre | `lat`, `lon` (exist) | |
| Radius | `radius_m` (new) | Default 100 m. 25 to 5,000. Sent as `positional_accuracy`. Drives "inside this place". |
| Locality | `locality` (new) | "Prince George, British Columbia, Canada". Editable. |
| Locality source | `locality_source` (new) | `gazetteer`, `region`, `inaturalist` or `user`. A `user` value is never overwritten. |
| Region | `region_id` (exists) | From `regionAt`, as today. |
| Default geoprivacy | `geoprivacy` (exists) | open, obscured or private. |
| Notes | `notes` (new) | Optional, up to 2,000 characters. Not sent anywhere. |
| Created from | `origin` (new) | `map`, `photo` or `inaturalist`, for the "Suggested" provenance line and support. |
| Last used | `last_used_at` (new) | For "Recent" in the picker. Not synced. |
| Counts | derived | Photos inside (label match or point within radius), and iNaturalist observations inside. |

### Migration sketch

**Next free migration** (180 when this was written; take whatever is free when the work starts).

```sql
-- Named places: a spot gets a radius, a locality worked out once from its point, notes, where it
-- came from, and when it was last used (for the picker's Recent group).
ALTER TABLE saved_spots
  ADD COLUMN radius_m integer NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 25 AND 5000),
  ADD COLUMN locality text CHECK (char_length(locality) <= 300),
  ADD COLUMN locality_source text CHECK (locality_source IN ('gazetteer', 'region', 'inaturalist', 'user')),
  ADD COLUMN notes text CHECK (char_length(notes) <= 2000),
  ADD COLUMN origin text NOT NULL DEFAULT 'map' CHECK (origin IN ('map', 'photo', 'inaturalist')),
  ADD COLUMN last_used_at timestamptz;

-- Using a place isn't an edit worth syncing (like inat_ignored_at on captures, migration 177).
CREATE OR REPLACE FUNCTION saved_spots_touch_updated_at() ...  -- sync_touch_updated_at minus 'last_used_at'
-- (swap the trigger on saved_spots to it)

-- Where a photo's point came from, so a place never replaces camera GPS silently.
-- NULL stays "camera or unknown"; earlier placings can't be told apart and are treated as camera.
ALTER TABLE captures_all DROP CONSTRAINT captures_all_location_source_check;
ALTER TABLE captures_all ADD CONSTRAINT captures_all_location_source_check
  CHECK (location_source IN ('inaturalist', 'spot', 'map'));

-- Suggestions the user turned down (wave 3; may ship in its own migration).
CREATE TABLE place_suggestion_dismissals (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cell text NOT NULL,               -- the cluster's anchor: its 200 m grid cell of the median point
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cell)
);
```

Sync (per `docs/docs/contributing/data-model.md` and migration 163): the new spot columns except
`last_used_at` go into the `saved_spot` field list in `apps/api/src/sync/library.ts` and its mirror in
`libraryMirror.ts`. The tombstone trigger is unchanged. `location_source` already travels with captures if
the capture field list carries it. PLACE-01 checks that and adds it if it doesn't. Dismissals are per install
and not synced, like iNaturalist links (they depend on the per-install iNaturalist data). This is all user
data, and nothing downloaded ever writes these tables.

## 2. The locality, worked out once

On create, on move, and on "Work it out again", unless `locality_source = 'user'`:

1. **Gazetteer (after MAP-07):** the nearest populated place within 25 km, the radius MAP-12 already uses,
   formatted `{town}, {province}, {country}` from Lifer's own region names. MAP-12's lookup is reused, not
   written twice. Province names are written in full ("British Columbia"). Short codes like "BC" only appear
   if the regions table carries them. **Not verified:** whether it does, and how far `cities5000` reaches in
   sparse areas. Past 25 km Lifer falls back to step 3, because "Near Prince George" said 60 km out would
   mislead.
2. **iNaturalist (when the place came from observations):** iNaturalist's `place_guess` text, cleaned
   (section 4). It is used only when the text ends in the place's own region or country name, so a stale or
   foreign string is never adopted.
3. **Regions only (before MAP-07, and as the fallback):** `regionPlaceName`, so "British Columbia, Canada".
   That is honest and coarse. When MAP-07 lands, a one-time pass upgrades every `region` locality to
   `gazetteer`. It's cheap, local, and never touches `user` values.

The locality is shown as the place's second line everywhere (picker row, Places list, map popup), with a
small "Edit" in the place's detail. A source hint ("From your iNaturalist observations") shows only on the
detail screen, not on every row (rule W5).

**Online reverse geocoding: not offered.** MAP-09 already ruled it out ("never: it would send coordinates").
Photon's forward search covers "find a town by name", and that sends only typed text. Typing the locality by
hand is always possible.

## 3. Picking a place

### The picker

One house component, `PlacePicker`, grown out of the existing `PlaceSearch` (rules C1, C2). It is not a new
lookalike. It stays a typeahead over `/places/locate`, with two changes:

- **Empty query** returns places too. `GET /places/locate?near=lat,lon` (the photos' median point, or their
  region's centre). The groups are **Nearby** (places within 50 km, nearest first, up to 5), **Recent**
  (by `last_used_at`, up to 5, without repeats) and **All places** (A to Z, with the rest loaded in pages of
  50 as you scroll). With a query, the ranking is the MAP-08 ranking, with ties broken by distance when
  `near` is given. `near` never leaves the computer: it is a local API parameter.
- The **last row** is always "New place from the map". It opens the existing point-picker modal, now with
  name, locality (prefilled once the pin drops), radius and privacy. On save, the new place is applied to the
  photos at hand.

```
+-----------------------------------------------+
| Search your places, e.g. King Fisher Pond     |
+-----------------------------------------------+
| NEARBY                                        |
|  * King Fisher Pond                    0.4 km |
|    Prince George, British Columbia, Canada    |
|  * Cottonwood Island Nature Park (obscured)   |
|    Prince George, British Columbia, Canada    |
| RECENT                                        |
|    Tofino mudflats                            |
|    Tofino, British Columbia, Canada           |
| ALL PLACES                                    |
|    Aaron's feeder                             |
|    ...                                        |
|-----------------------------------------------|
|  + New place from the map                     |
+-----------------------------------------------+
```

Long names wrap to two lines and then scale down, and are never cut off with an ellipsis (S8). The
distance shows only in the Nearby group. Privacy shows only when it isn't open.

### What choosing does

For the photos in hand, through the existing `applyLocation` job, which keeps Undo, progress and
background files:

- **Photos with no point:** they take the centre, the name as label, and the region.
  `location_source = 'spot'`, `location_accuracy_m = radius_m`.
- **Photos with their own point** (camera GPS, or anything with `location_source` NULL, `map` or
  `inaturalist`): they keep their point and take the name and region. If the point is more than
  `radius_m + 1 km` from the place, the picker asks inline first ("3 photos were taken 40 km from here.
  File them here anyway?"), because a wrong place is more likely than a wrong camera.
- **Photos previously filed under a place** (`spot`): their point moves to the new place. That is a re-file,
  not GPS.
- `last_used_at` is set.

`applyLocation` gets one new option, `keepOwnPoint`, and writes `location_source` and accuracy. The spot
apply route uses it by default. "Move these too" in the confirm row is the only way to replace camera GPS.

### Sending to iNaturalist

`sendObservation` changes in three ways:

- **Geoprivacy:** the strictest of (the place matched by label) and (the places whose radius contains the
  photo's point). This replaces `geoprivacyForLabel`, which closes gap 1. There is no species-based raise: iNaturalist hides
  threatened species' locations by itself (taxon geoprivacy, which the observer cannot turn off), so Lifer
  sends only the privacy the user set on their places (maintainer decision, 2026-11-04). Nothing offline is
  ever obscured; this only decides what goes to iNaturalist.
- **`positional_accuracy`:** the photo's `location_accuracy_m` when set (the place's radius for `spot`, or
  iNaturalist's own value for `inaturalist`). It is left out for camera GPS, as today.
  `submitted_positional_accuracy` is recorded, which keeps the 50 km "old guess" check working.
- **`place_guess`:** `{name}, {locality}` for open places. Just `{locality}` for obscured and private places,
  because iNaturalist shows `place_guess` publicly (the search found that it keeps the observer's text as a
  private place guess when obscured). **Not verified:** whether every iNaturalist client respects that.
  Leaving the name out costs nothing. A place without a locality falls back to today's label plus region.

### Where the picker appears

| Surface | Entry | Behaviour |
| --- | --- | --- |
| iNaturalist, To send cards and the sighting window | "Set place" on a card noted "Needs a location" | Picker, then the card shows the place, then Send. |
| iNaturalist, selection bar | "Set place and send" | Picker, then apply, then send the selection (apply and send are one background job). |
| Gallery send (`SendToInatMenuItem`) | When any selected photo has no point | One picker step: "Choose a place for 12 photos without a location", with "Send without a location" as the quiet second action (D2, never trapped: N5). |
| Map placing card, Needs placing tray | Replaces the search field | Same picker. Dropping a pin still works. |
| Coordinates dialog | Above the coordinate field | Picking fills the coordinates and label. |
| Places page | List rows | Nothing new to pick; this is where places are edited (section 5). |

Send flow with a place chosen:

```
+- Mallard, 4 photos ------------------------------------------+
|  [photo][photo][photo][photo]                                |
|  Oct 12, 2026                                                |
|  Place  [ King Fisher Pond                          v ]      |
|         Prince George, British Columbia, Canada              |
|         Sent with 100 m accuracy, location open              |
|                                                              |
|                                  [ Not this one ]  [ Send ]  |
+--------------------------------------------------------------+
```

The accuracy and privacy line reads as one sentence and appears only once a place is chosen (W5, W9).

## 4. Suggestions from your iNaturalist pins

### Input

The user's own observations, as stored by the iNaturalist "existing observations" sync (section 6). Each
point is `private_location` when present (the owner may see their own true point; `observationPoint`
already prefers it), then `location`. Skipped: observations without a point, with `positional_accuracy`
over 1,000 m, or already inside an existing place's radius plus 50 m. Those last ones are the existing
"nearby" suggestion's job. Placed local photos are **not** input in 1.0 (open decision 4).

### Algorithm

Grid-hash single link, then a spread guard. It is deterministic, cheap, and easy to explain ("these
observations are each within about 200 m of another").

1. Sort points by observation id, which makes every run identical.
2. Hash each point into a 200 m cell: `floor(lat / dLat)`, `floor(lon / dLon(lat))`, with longitude scaled
   by latitude.
3. For each point, check the 3 x 3 neighbouring cells. Two points link when the haversine distance is at
   most `L = clamp(150 + min(accA, accB) / 2, 150, 300)` metres, with a missing accuracy counted as 0. A
   loose GPS fix stretches the link a little but never past 300 m.
4. Union-find, with the root being the smallest id, gives the clusters.
5. **Spread guard:** a cluster whose points reach more than 1 km from its median point (single link can
   chain along a river trail) is clustered again with `L = 100`. Pieces that are still too wide are
   dropped. A trail is not a spot.
6. **Keep** clusters with at least 3 observations on at least 2 different days. A place you returned to,
   not one outing.
7. **Centre** is the coordinate-wise median. **Radius** is the distance that covers 90% of the points,
   rounded up to 50 m, between 50 and 1,000.
8. **Anchor:** the 200 m cell of the centre, used for dismissals and to keep suggestions stable across
   runs.

Cost: about one pass over n points with a constant number of neighbour checks. 50,000 points takes well
under a second in Node, with no database spatial index needed. It runs as a short background job after each
observation sync, never while the user waits (P6).

**Why not DBSCAN or k-means:** k-means needs a cluster count and isn't stable. DBSCAN with `minPts = 3` is
nearly the same as this, but harder to explain and to tune per accuracy. HDBSCAN is overkill.

### Naming the suggestion

The best guess goes into the name field. The others become two "Or:" chips.

1. **The observations' own `place_guess` text:** split on commas, drop parts that match the region,
   country or locality names, drop parts that start with a digit (street addresses: never prefill an
   address), and take the most common remaining first part if at least 40% of the cluster shares it
   (case- and accent-insensitive, per Q4). "Cottonwood Park" comes from here. **Not verified:** iNaturalist's
   apps fill `place_guess` by reverse geocoding on the device, and the formats vary. The example "British
   Columbia, Canada prince george" shows the order isn't fixed. The 40% rule and the region-name stripping
   are the guard.
2. **A gazetteer nature feature** (park, reserve, lake, marsh: the MAP-07 pack features) within the radius
   plus 500 m, nearest first. Only after MAP-07.
3. **"Near {town}"** from the locality, or failing that **the region name.** The user is expected to rename
   this one.

### Privacy for a suggested place

Default geoprivacy = **the strictest** among its observations' geoprivacy. Lifer never suggests a place as more open than
the user's own observations were; iNaturalist's own protection of threatened species applies on top, outside Lifer. The card says why when it isn't open ("Obscured, like 4 of these
observations").

### Where suggestions show

- **Places page:** a "Suggested places" section above the list, with a count. It is hidden when there are
  none (A1).
- **iNaturalist page:** one line after a sync that found new ones ("4 places you visit often. Name them"),
  linking to Places. No second copy of the cards (F6, U1).

Suggestion card (the shared card shell, C10):

```
+- Suggested place ------------------------------------------+
| +-------------+  [ Cottonwood Park                      ]  |
| |  mini map   |  Or: Cottonwood Island Nature Park,        |
| |  ring+dots  |      Near Prince George                    |
| +-------------+  Prince George, British Columbia, Canada   |
| [th][th][th][th] +23   27 observations on 9 days          |
|                  Obscured, like 4 of these observations    |
|                  [x] Also file 18 photos with no location  |
|                                                            |
|                                 [ Dismiss ]  [ Add place ] |
+------------------------------------------------------------+
```

- **Add place** (Enter): creates the spot (`origin = 'inaturalist'`, the centre, radius, locality, privacy).
  When the box is ticked, it then applies the place to linked local photos that have **no point** (the
  same `keepOwnPoint` apply, with one Undo). The box is ticked by default only when there are such photos,
  and hidden otherwise (A1).
- **Rename** is just editing the field. It isn't a separate button (A3).
- **Dismiss:** writes the anchor cell to `place_suggestion_dismissals`, with Undo in the toast (F3). That
  anchor is never suggested again, even if more observations arrive there. "Show dismissed" sits at the foot
  of the section for regret.
- The thumbnails are linked local photos, falling back to the observations' iNaturalist photos when the
  sync has cached them (section 6).

## 5. UI placement, keyboard, extremes

- **Places page (`ManagePlacesPage`):** Suggested places, then the list (name, locality, photo count,
  privacy badge when not open). The row editor gains radius, locality and notes. Renaming a place with
  photos asks inline: "Also rename it on 42 photos" (ticked by default, undoable; open decision 2).
- **Map:** spot rings already show. The ring is drawn at `radius_m`, and clicking it opens the place's
  popup (name, locality, counts, "Show photos"). Suggestions are not drawn on the map in 1.0.
- **Settings:** nothing new. No online reverse geocoder means no new privacy setting (W5).
- **Keyboard:** the picker opens with focus in the search field, arrows move, Enter picks, Escape closes
  and returns focus to the trigger (M4, Y1). The "New place from the map" row is reachable by arrow. On a
  suggestion card, Tab goes name field, then chips, checkbox, Dismiss, Add place. Enter in the name field adds
  the place.
- **Narrow windows (360 px):** the picker fills the width as a sheet. Suggestion cards stack, with the map
  above the name field.
- **Extremes (S7):** 500 places means the picker never lists all of them unpaged (Nearby 5, Recent 5, then
  pages of 50 under All places, with the search narrowing on the server). For 120-character names, see the
  wrap rule above. The suggestion card name field is multi-line. With 50,000 observations, clustering runs in
  the background, and suggestions are capped at 50, sorted by observation count, with "Show more" in pages
  of 50. The extreme seed gets 500 spots, 300-character names and 50,000 fake observation points (shared
  with MAP-13).

## 6. Data flow with the "existing observations" sync

Another session is building the link-existing sync (fetch the user's observations, match them to local
photos, link them, write locations back to photos that have none). Per the latest maintainer note, that
matcher compares image content (CLIP embeddings over small previews), with taxon and date as the cheap
filter. **None of it had landed when this was written** (no new migration after 179, and no new files in
`apps/api/src/inaturalist/`), so this section is a contract to check against when it lands.

What this plan needs from that sync, per observation, kept locally:

- observation id, taxon id, `observed_on`, `updated_at`
- the point (`private_location` preferred), `positional_accuracy`, `geoprivacy`, `place_guess`
- the linked local capture ids (its link rows), and the cached preview photo id or path, if it keeps
  previews

If that sync only stores link rows and not every observation's point, **PLACE-07 adds the
`inaturalist_observation_points` cache** (user, observation id, the fields above). The sync fills it from
the pages it already fetches. It never makes a second request, and the full observation JSON is not stored.

Incremental: the sync already pages by `updated_since`. PLACE-07 upserts those rows and deletes the ones it
reports gone. Clustering then reruns over the cache only (seconds), after the sync finishes. Points that
haven't changed don't change the anchors, so accepted and dismissed suggestions stay put.

**Overlap to avoid:** writing locations back to photos belongs to that sync, not to this plan. This plan
only reads its data, and adds the "also file photos with no location" step, which goes through the same
`applyLocation`.

## 7. Work packages

Wave 1 needs no gazetteer. Wave 2 needs MAP-07 for the full locality but ships its fallback first. Wave 3
needs the link-existing sync.

### Wave 1: named places on top of saved spots, and the picker

#### PLACE-01 Spot fields, location source and privacy by place

- **Model:** Opus 5.5. **Review:** Opus 5.5 (data and privacy).
- **Goal:** gaps 1, 2 and 4 on the data side.
- **Scope:** in: the migration in section 1 (spot columns, touch trigger, `location_source` values; the
  dismissal table may wait for PLACE-06); the spot routes accept and return `radius_m`, `locality`,
  `localitySource`, `notes`, `origin`; the locality is filled from `regionPlaceName` on create and move (the
  interim rule); `geoprivacyForPhoto` (label or point within radius, strictest wins) replaces
  `geoprivacyForLabel`; `applyLocation` gains `keepOwnPoint` and writes `location_source` and accuracy
  (`map` for map placing, `spot` for spots); sync field lists. Out: UI.
- **Files:** migration (next free), `places/savedSpots.ts` and test, `captures/locationHistory.ts`,
  `inaturalist/routes.ts` (the one call), `sync/library.ts`, `sync/libraryMirror.ts` and tests.
- **Depends on:** none.
- **Tests:** a renamed spot still sends obscured (regression for gap 1); a photo inside two spots takes the
  stricter; a camera-GPS photo keeps its point under `keepOwnPoint`; undo restores `location_source`; a spot
  with the new fields round-trips through sync; `last_used_at` doesn't bump `updated_at`.
- **UX checks:** none (API).
- **Risks:** older placings stay NULL and count as camera, which is safe but stricter than needed.
- **Parallel with:** PLACE-02 once the route shapes are agreed.

#### PLACE-02 PlacePicker

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** the drop-down in section 3.
- **Scope:** in: `/places/locate` gains `near` and the empty-query groups (Nearby, Recent, All places
  paged); `PlaceSearch` grows into `PlacePicker` (same component, renamed, existing callers moved); the "New
  place from the map" row, opening `PointPickerMap` with name, locality, radius and privacy; the far-away
  confirm row; locales. Out: send-flow wiring (PLACE-04).
- **Files:** `places/locate.ts` and test, `components/PlaceSearch.tsx` (to `PlacePicker.tsx`),
  `PointPickerMap.tsx`, `CoordinatesModal.tsx`, `map/NeedsPlacingTray.tsx`, `PhotoMap.tsx`, `hooks/useSavedSpots.ts`, locales.
- **Depends on:** PLACE-01.
- **Tests:** empty query with `near` lists the nearest first; 500 spots page in 50s; a 300-character
  query; keyboard e2e (arrows, Enter, Escape returns focus); picking files a GPS photo without moving it.
- **UX checks:** C1, C2, Q1, Q2, Q4, W10, S7, S8, M1, M4, Y1, D7.
- **Risks:** the empty-query groups repeating a place; dedupe by id.
- **Parallel with:** PLACE-03.

#### PLACE-03 Places page: radius, locality, notes, rename follow-through

- **Model:** Sonnet 5.5. **Review:** Sonnet 5.5.
- **Goal:** edit everything a place holds, and make renaming keep its photos.
- **Scope:** in: row editor fields; map ring at `radius_m`; "Also rename it on N photos" (a location job,
  undoable); the guide section in `docs/docs/guides/photo-map.md`. Out: suggestions.
- **Files:** `components/SavedSpots.tsx`, `pages/ManagePlacesPage.tsx`, `PhotoMap.tsx`, `savedSpots.ts`
  (rename route option), docs, locales.
- **Depends on:** PLACE-01.
- **Tests:** rename with follow-through relabels and undoes; a 120-character name wraps in list, ring
  popup and editor at 360 px.
- **UX checks:** S8, L3, L4, F3, W5, W9.
- **Parallel with:** PLACE-02.

### Wave 2: locality and the send flow

#### PLACE-04 Send with a place

- **Model:** Opus 5.5. **Review:** Opus 5.5 (privacy: what leaves the computer).
- **Goal:** pick and go, without iNaturalist's map.
- **Scope:** in: "Set place" on To send cards and in the sighting window; "Set place and send" on the
  selection bar (apply then send as one job, Cancel, progress); the Gallery send step for photos without a
  point; `DraftObservation.positionalAccuracy`; `place_guess` rules (locality only when obscured or
  private); the sensitive-species raise, shown on the card; `submitted_positional_accuracy` recorded;
  `docs/docs/guides/inaturalist.md`. Out: changing what the To finish check copies back.
- **Files:** `inaturalist/client.ts` and test, `inaturalist/routes.ts`, `pages/inaturalist/SightingsTab.tsx`,
  `CardGrid.tsx`, `components/SendToInatMenuItem.tsx`, `pages/gallery/GallerySelection.tsx`, docs, locales.
- **Depends on:** PLACE-01, PLACE-02.
- **Tests:** an obscured place sends locality-only `place_guess` and obscured; an open place sends the
  name plus locality and the radius as accuracy; camera GPS sends no accuracy; a sensitive species raises
  privacy; "Send without a location" still works; mocked-network field check.
- **UX checks:** D2, D3, F1, F2, N5, W8, W9, A4.
- **Risks:** iNaturalist's handling of `place_guess` on obscured observations isn't verified; the
  locality-only rule makes that moot.
- **Parallel with:** PLACE-05.

#### PLACE-05 Locality from the gazetteer

- **Progress (2026-11-04):** create and move use `localityAt()` (`apps/api/src/places/gazetteer.ts`):
  nearest town within 25 km, else the region name, source `gazetteer` or `region`. A catalog update that
  brings the town list upgrades `region` localities (`upgradeRegionLocalities`, never `user` ones), and the
  Places editor's **Work it out again** clears a typed one so it is worked out on save.

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** "Prince George, British Columbia, Canada" instead of "British Columbia, Canada".
- **Scope:** in: use MAP-12's nearest-town lookup (25 km) for spot locality; a one-time upgrade pass of
  `region` localities when gazetteer rows appear (on seed or pack install), never touching `user` ones;
  "Work it out again" in the editor. Out: nature-feature names (PLACE-06).
- **Files:** `places/savedSpots.ts`, the MAP-12 lookup module, `offlinePacks/apply.ts` (hook the
  upgrade), test.
- **Depends on:** MAP-07, MAP-12 (or this package writes the lookup and MAP-12 reuses it, whichever
  starts first).
- **Tests:** a point 10 km out gets the town; 60 km out falls back to the region; a user-edited locality
  survives a pack install.
- **UX checks:** S5, W11.
- **Parallel with:** PLACE-04.

### Wave 3: suggested places

#### PLACE-06 Clustering and naming

- **Model:** Opus 5.5. **Review:** Opus 5.5 (algorithm, privacy).
- **Goal:** section 4, server side.
- **Scope:** in: a pure `clusterPoints()` (grid hash, link rule, spread guard, keep rule, median, radius,
  anchor); a pure `suggestName()` (`place_guess` parsing, gazetteer feature when present, fallback);
  privacy default; the dismissal table; `GET /places/suggestions`, `POST .../accept` (create plus optional
  apply to linked photos without a point), `POST .../dismiss` and undo; a background job after each sync.
  Out: UI.
- **Files:** new `apps/api/src/places/suggestions.ts` and tests, migration if not done in PLACE-01.
- **Depends on:** PLACE-01, PLACE-07 (or the link-existing sync's table).
- **Tests:** pure: identical output for shuffled input; a 3 km trail chain is split or dropped; 3 points
  on one day is not kept; an address part is never a name; "Cottonwood Park" wins at 40%; a dismissed
  anchor never returns; strictest privacy wins; 50,000 points under 1 s.
- **UX checks:** none (API).
- **Risks:** `place_guess` formats vary by iNaturalist client; worst case, the fallback names are dull,
  never wrong.
- **Parallel with:** PLACE-08 against a fixture.

#### PLACE-07 Observation points from the iNaturalist sync

- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** the data in section 6, with no extra requests.
- **Scope:** in: only if the link-existing sync doesn't already keep it: the
  `inaturalist_observation_points` cache filled from the pages that sync fetches, an upsert on
  `updated_since`, and removal of rows for observations gone from iNaturalist. Out: matching, write-back
  (the other work).
- **Files:** that sync's module in `apps/api/src/inaturalist/`, migration.
- **Depends on:** the link-existing sync landing.
- **Tests:** mocked pages fill and update the cache; a second sync makes no extra calls.
- **Risks:** stepping on the other session's files; coordinate before editing (parallel sessions note).
- **Parallel with:** PLACE-06.

#### PLACE-08 Suggested places UI

- **Model:** Sonnet 5.5. **Review:** Opus 5.5.
- **Goal:** section 4, the cards.
- **Scope:** in: "Suggested places" section on Places (shared card, mini map, thumbnails, name field with
  "Or:" chips, privacy reason, apply checkbox, Dismiss with Undo, Add place, Show dismissed, Show more);
  the one line on the iNaturalist page after a sync; guide update. Out: map overlay of suggestions.
- **Files:** `pages/ManagePlacesPage.tsx`, new `components/PlaceSuggestionCard.tsx` on the shared card,
  `pages/InaturalistPage.tsx`, docs, locales.
- **Depends on:** PLACE-06.
- **Tests:** e2e: accept with apply then undo; dismiss then reload stays gone; 50 suggestions with
  300-character `place_guess` names at 360 px.
- **UX checks:** C10, C11, A1, A3, D5, F3, F6, S7, S8, U1, W5.
- **Parallel with:** none.

### Order

```
Wave 1:  PLACE-01 --> PLACE-02, PLACE-03 (parallel)
Wave 2:  PLACE-04 (after 02)   PLACE-05 (after MAP-07 / MAP-12)
Wave 3:  link-existing sync lands --> PLACE-07 --> PLACE-06 --> PLACE-08
```

**Overlap:** MAP-07 provides the gazetteer, MAP-12 the nearest-town lookup (shared with PLACE-05), MAP-08
the search ranking (PLACE-02 extends the same route, so whichever is second rebases), and MAP-13 the
extreme seed and the spots tab on the map (PLACE-02's picker should be what that tab uses). The
link-existing sync owns fetching, matching and location write-back. This plan only reads its data.

## Decisions made by the maintainer (2026-11-04)

1. **Places do not replace the free-text location label.** Keep the label that imports and Lightroom write. Privacy is matched by the photo's point inside a place's radius as well as by name.
2. **Renaming a place renames its photos too.** Ticked by default and undoable.
3. **Privacy default for a suggested place is the strictest of its observations, raised for sensitive species.** Added: the user can **export their places and their location data** whenever they choose (PLACE-09 below). Nothing is sent anywhere; it is a file the user saves.
4. **Suggestions also come from the user's placed local photos, before 1.0** (PLACE-10 below), not only from iNaturalist pins.
5. **Cluster thresholds** start at 200 m grouping, 1 km spread, 3 observations on 2 days. Added: **a place is recognised again whenever the user returns to it**, weeks, months or years later. Any time photos are placed, sent or imported near an existing place (inside its radius, or within about 150 m of its centre when the radius is small), Lifer offers that place first ("This looks like King Fisher Pond. Use it?"), never expiring and never depending on when the place was made. Wire this into PLACE-02 (the picker's Nearby group, ranked by distance) and PLACE-04 (the send flow), and into the map's placing card.
6. **Default radius for a hand-made place is 100 m.**
7. **Online place lookup is allowed, with a one-time warning and a setting to turn it off (revised by the maintainer).** Reverse geocoding means asking a website to turn a point on the map into a place name or address, so the point's coordinates leave the computer. The first time it would happen, Lifer shows one plain line saying so, with a way to turn it off right there, and Settings has a switch ("Online place names and search", Automatic by default, Off to never use the network for it). The offline town list is still tried first and is the only source when the setting is Off or the device is offline. There is no sensitive-species exception for online lookups (maintainer decision: the service only sees coordinates and an IP address and cannot tell a point belongs to a species); the point is rounded to about 100 m before it is sent. The sensitive-species protections that remain are on uploads to iNaturalist (geoprivacy raised). The same setting and the same notice cover online place search on the map (typed text is sent).

### Added work packages

#### PLACE-09 Export places and location data
- **Model:** Sonnet 5.5. **Review:** Opus 5.5 (privacy).
- **Goal:** the user can save their named places and, if they choose, the locations of their photos to a file.
- **Scope:** in: a "Export places" action on the Places page (CSV and GeoJSON; columns: name, locality, latitude, longitude, radius, geoprivacy, notes, photo count), and an optional second choice "Include photo locations" (adds one row per photo: capture time, species, latitude, longitude, place name), with a plain sentence saying the file contains exact locations and where it is saved. Sensitive-species photos are left out of the photo list unless the user ticks "Include sensitive species" (default off, with the reason in one line). The file is written locally through the existing download or save-dialog path; no network, nothing stored on any server. Out: GPX import (rejected feature), sharing links.
- **Files:** `apps/api/src/places/exportPlaces.ts` (new), `apps/web/src/pages/ManagePlacesPage.tsx`, locale files, docs.
- **Tests and acceptance:** unit tests for the file contents (escaping, the sensitive-species default, a 50,000-photo export streams without loading everything), a component test for the dialog.
- **Parallel with:** PLACE-03.

#### Done early (2026-11-04): place marks and suggestions from local photos

At the user's request ("group nearby photos to the same location from the coarser view over time"):
`/gallery/map` returns `places` (photos whose point is inside each place, by `places/spotArea.ts`)
and leaves them out of `cells`, so a place draws as one mark with its name and count; the panel
filters with `spotId`. `places/suggestions.ts` is PLACE-06/10's clustering over local photo points
only (100 m link, 1 km spread guard, 3 photos on 2 days, not within a place's radius plus 100 m),
cached per user and recomputed in the background only when photos, places or dismissals change;
the town comes from the gazetteer. Dismissals: migration 184. UI: `PlaceSuggestions` in the map
tray and on Places, naming through `AddSpotModal`. Still open: iNaturalist observations as input
(PLACE-07), `place_guess` naming, the suggestion card with mini map and thumbnails (PLACE-08).

#### PLACE-10 Suggestions from placed local photos
- **Model:** Opus 5.5. **Review:** Opus 5.5.
- **Goal:** suggest named places from photos the user has already placed, not only from iNaturalist observations (decision 4, before 1.0).
- **Scope:** in: feed the same clustering as PLACE-06 with photo points that are not already inside a named place (camera GPS, typed and placed points), weighting by distinct days like observations; one suggestion list that merges both sources and marks where a suggestion came from; the same naming, privacy and dismissal rules. Out: any use of region-only photos.
- **Depends on:** PLACE-06. **Parallel with:** PLACE-08.

## 8. Open decisions

1. **Do places replace the free-text `location_label`?** Recommend **no**. Keep the label as free text
   (imports, Lightroom and XMP all write it), and treat a label that equals a place's name as "filed under"
   it. Adding a `captures.saved_spot_id` would be cleaner, but it needs capture sync mapping and a views
   rebuild. The point-in-radius privacy rule and rename follow-through close the real risk without it.
2. **Renaming a place renames its photos' labels?** Recommend **yes, ticked by default, undoable**. This
   changes today's "a spot is only a shortcut" rule, so it's your call.
3. **Privacy default for suggested places:** recommend **the strictest of its observations, raised for
   sensitive species**. The alternative (always obscured) is safer but nags users whose observations are all
   open.
4. **Suggestions from placed local photos too?** Recommend **not in 1.0**. Photos already in a place get the
   existing nearby suggestion. Unplaced ones have no point. Placed photos without a place would add noise from
   one-off trips. It's cheap to add later: the same `clusterPoints()`.
5. **Cluster thresholds:** 200 m link (150 to 300 with accuracy), 1 km spread, at least 3 observations on
   at least 2 days. Recommend shipping these, then tuning on your own observations once the sync lands
   (there was no data to test against here).
6. **Default radius for a hand-made place:** recommend **100 m** (a pond or a feeder; it's sent as
   accuracy, so smaller looks falsely precise and larger blurs research grade). 250 m is the other option.
7. **Online reverse geocoding:** recommend **never**, matching MAP-09. Say if you want an opt-in Photon
   reverse lookup anyway. It would send the place's point, once, when you create it.

## Not verified

- How far GeoNames `cities5000` and the pack features reach in sparse areas, and whether region names
  carry short codes ("BC").
- How iNaturalist clients format `place_guess`, and whether every client hides it on obscured
  observations. The plan avoids depending on either.
- The link-existing sync's storage: nothing had landed when this was written.

## References

- iNaturalist "Pinned locations" (saved reusable places, with a title, a geoprivacy setting and a centre
  you can set away from home):
  [iNat FAQ: can I pin a location](https://www.inaturalist.org/posts/48950-inat-faq-can-i-pin-a-location-that-i-visit-over-and-over-again),
  [forum: pinned locations on the Edit page](https://forum.inaturalist.org/t/select-a-pinned-location-on-the-edit-page-for-already-uploaded-observations/3626/4).
  Lifer's places do the same thing on the Lifer side, so the user never needs iNaturalist's own copy.
- iNaturalist `positional_accuracy` (a radius in metres, drawn as a circle, which affects place
  assignment) and `place_guess` (the observer's locality text):
  [Observation Location Accuracy](https://www.inaturalist.org/posts/2035-observation-location-accuracy),
  [terminology](https://www.inaturalist.org/terminology).
- Lightroom Classic Map module "Saved Locations" (a radius, plus a Private flag that strips location on
  export): [Adobe help](https://helpx.adobe.com/lightroom-classic/help/maps-module.html). This is the model
  for radius and per-place privacy.
- eBird personal locations and hotspot merge (precise personal spots, merge duplicates):
  [Choosing locations](https://support.ebird.org/support/solutions/articles/48000850891),
  [Updates to My Locations](https://ebird.org/news/updates-to-my-locations). This is why suggestions suggest
  and never merge silently.
- Apple Photos has no user-named places; it shows reverse-geocoded names from Apple Maps, which sends
  coordinates. Noted from general knowledge, not checked here.
