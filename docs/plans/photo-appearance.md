# Photo appearance

How the animal in a photo looks: life stage, sex, plumage and colour morph. Some people go after
morphs, and a juvenile or a rare morph can look nothing like the species' usual adult (a juvenile
angelfish, a dark-morph hawk). Status: built (migration 196).

## Fields

Nullable columns on `captures_all` (and the `captures` view). NULL means not set.

| Field (API) | Column       | Kind                           | Values                                                         |
| ----------- | ------------ | ------------------------------ | -------------------------------------------------------------- |
| `lifeStage` | `life_stage` | CHECK-constrained text         | egg, larva, nymph, pupa, juvenile, subadult, adult             |
| `sex`       | `sex`        | CHECK-constrained text         | male, female, unknown                                          |
| `plumage`   | `plumage`    | free text, 1 to 100 characters | suggested: breeding, non-breeding, eclipse, immature, moulting |
| `morph`     | `morph`      | free text, 1 to 100 characters | suggested: the morphs already used on the page's photos        |

Why each kind:

- **Life stage** is a short list that covers every group Lifer catalogs (insects need larva, nymph
  and pupa; fish and birds juvenile and subadult), and iNaturalist's Life Stage annotation maps onto
  it, so a CHECK keeps the data clean for filters and summaries.
- **Sex** follows iNaturalist's Sex annotation: male, female and "Cannot Be Determined" as
  `unknown` (looked at, can't tell), which differs from not set.
- **Plumage** varies by group and by birder ("first winter", "alternate", "moulting"), so it's free
  text with a few suggestions rather than a list that would always miss someone's term.
- **Morph** is open ended (colour phases, aquarium strains, regional forms), so it's free text with
  the user's own earlier morphs as suggestions.

The vocabulary lives in `packages/shared/src/appearance.ts`.

## Writing and reading

- `POST /api/captures/appearance` (scope `photos.write`): `{ captureIds, lifeStage?, sex?, plumage?, morph? }`
  for one photo or up to 5,000; a field left out stays, null clears, blank text clears. The web app
  sends bigger selections in parts.
- Returned in the Gallery item (`lifeStage`, `sex`, `plumage`, `morph`), the species page's captures
  (`life_stage` and so on, as that payload is snake_case) and the API-key photo feed `GET /api/captures`.
- Web: badges and an **Add appearance** / **Edit** link in the photo viewer's caption, a **Set
  appearance** action in the Gallery's selection bar (fields start at **Leave as is**), and a quiet
  "Your photos show: ..." line on the species page (capped at 8 values, then "and N more").

## Gallery filters

The Filters menu's **Appearance** section (Gallery, albums, trips and the smart album builder):
life stage and sex as pills, plumage and morph as checklists with photo counts, searchable past 8.
Only values the library holds are offered (`GET /api/gallery/appearance`, plumage and morph grouped
ignoring case, at most 500 each, most used first). They're repeated query params, `lifeStage`,
`sex`, `plumage` and `morph`, in the URL, the gallery API and smart album and pinned filter rules:
any value within a kind matches, and every kind set must match. Plumage and morph match ignoring
case. No index: on 300,000 photos a page takes under 50 ms whether a value is rare or common.

## Sync

The `updated_at` trigger compares whole rows, so editing any of the four bumps `updated_at` like
other capture edits. The desktop-server change feed (`apps/api/src/sync/changes.ts`) carries them in
`captureFields`, `CAPTURE_COLUMNS`, `captureFromRow` and `CAPTURE_META`, so pull, push and mirror
all write them. Deletes already go through the capture tombstones; nothing new is needed there.

## iNaturalist

The observation list Lifer already reads returns `annotations`, so no new call is made:
`parseObservation` keeps Life Stage (attribute 1) and Sex (attribute 9), skipping voted-down ones.
When a photo is linked to an observation found on iNaturalist, it takes that life stage and sex where
it has none of its own. The write is recorded on the link (`link_writes`), so Unlink takes it back
unless the user changed it since. Observations cached before this change carry no annotations until
iNaturalist reports them changed. Plumage has no iNaturalist annotation to map.

## Not done

- **Search words**: "juvenile" stays a picture word for CLIP. Reading it as the life stage filter
  would hide every juvenile photo nobody has marked yet.
- **Files**: not written to XMP. There is no standard field, and a keyword would come back as a tag
  on reimport.
- **Export and import**: there is no per-field data export; backups copy the whole database, so
  these columns come along.

## Later: species forms

`species_forms` (migration 196) is an empty table for what's known about a species' forms:
`species_id`, `kind` (life_stage, morph or plumage), `name`, `description`, and
`mistaken_for_species_id` for a form often taken for another species (a juvenile that looks like a
different fish). The catalog seed doesn't carry it and nothing reads it yet. A later pass could fill
it from field guides, suggest a photo's morph from it, and link a photo's morph to its description.
