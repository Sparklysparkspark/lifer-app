# Archive health check

Catch originals that silently changed (bit rot, corruption), went missing, or became unreadable.
Out of scope: redundancy or "only on one drive" warnings, and any cleanup or deletion suggestions.

## What the user sees

One row in Settings > Storage:

- "Archive health: Last checked 3 days ago · All 48,210 files OK"
- "Archive health: 3 files changed or unreadable" (links to a list)
- While running: "Checking files… 12,400 of 48,210"
- Drive offline: "Last checked 3 days ago · 1,200 files on Nature SSD not checked (drive not connected)"

The list is a `ManageListPage` with one row per problem file: thumbnail, species, file path, and
the problem ("Contents changed", "Can't be read", "Missing"). Actions: **Reveal in Finder** (when the
file exists) and **Ignore**. Ignore on a changed file accepts its current contents as the new
baseline; on a missing or unreadable file it hides that file from future checks.

One switch: **Check archive health** (on by default).

## How it works

**Checksum.** `originals.content_hash` is already a full-file sha256 (`fileFingerprint.ts`), but it
can't be reused as the baseline: Lifer embeds metadata into managed JPEG, TIFF, PNG, DNG, WebP and
HEIC files after import (`exif.ts` `metadataGoesInFile`), so the bytes drift from it, and it must
stay the import-time hash because dedup, reimport and trip relinking match on it. So add a separate
baseline: `verified_hash` plus the file's modification time when it was hashed.

**Telling edits from corruption.** Bit rot and bad sectors change bytes without touching the
modification time. Every legitimate edit (Lifer's exiftool writes, which don't pass `-P`, or the
user saving in Lightroom) bumps it. Rule per file:

| On disk now | Result |
| --- | --- |
| mtime differs from baseline | Edited. Rehash, store new baseline, no alarm. |
| mtime same, hash same | OK. |
| mtime same, hash differs | **Changed** (flag it). |
| read error (EIO, EACCES) | **Unreadable**. |
| file gone, its folder still there | **Missing**. |
| drive disconnected, or the folder itself is gone | Skipped, not flagged. |

No image-data-only hash: format-specific, slower, and the mtime rule already covers Lifer's writes
with no hooks.

**When the baseline is stored.**
- At import: `insertOriginals` (`captureRows.ts`) sets `verified_hash = content_hash` and
  `verified_mtime` from a stat of the final file. Lifer's post-import metadata write bumps the
  mtime, so the first check quietly re-baselines.
- Backfill: none as a separate job. The migration seeds `verified_hash` for RAW files (never written
  by Lifer, sidecars only) so rot that already happened is caught on the first pass. Every other
  existing file gets its baseline on its first check.

**How checks run.** One background job (`createJob("archive-health")`, like
`embeddingBackfill.ts`), started a few minutes after launch:
- Picks rows `ORDER BY checked_at NULLS FIRST` where `checked_at` is older than 90 days, in batches
  of 100, skipping trashed captures and `health = 'ignored'`. Hidden captures are included.
- Resolves paths with `resolveOriginalPaths` (`storageVolumes/resolve.ts`); `connected: false`
  rows are skipped and picked up next time the drive is attached.
- One file at a time, streamed through the existing `computeContentHash`, throttled to about
  50 MB/s, and paused while an import or trip scan is running.
- Writes `checked_at` per file, so quitting mid-pass loses nothing: it resumes where it stopped.
- `last_full_pass_at` and the switch live in `install_settings`; no new settings table.

**Cost, 200k files / 20 TB.** At the 50 MB/s cap a full pass is about 110 hours of app uptime
(roughly 2 weeks if the desktop app is open 8 hours a day; under 5 days on an always-on server).
Unthrottled on a single HDD (~150 MB/s) it would be about 37 hours. sha256 at 50 MB/s is a few
percent of one core. Database cost is one small UPDATE per file. A 90-day cycle keeps that well
inside the window.

## Migration

Needed: the existing hash must stay the import identity, so the baseline needs its own columns.

```sql
-- Archive health: a per-file baseline separate from content_hash (the import identity), which
-- drifts once Lifer embeds metadata into a file.
ALTER TABLE originals
  ADD COLUMN verified_hash  text NULL,
  ADD COLUMN verified_mtime timestamptz NULL,
  ADD COLUMN checked_at     timestamptz NULL,
  ADD COLUMN health         text NULL CHECK (health IN ('changed', 'unreadable', 'missing', 'ignored'));

-- Lifer never writes into a RAW (sidecars only), so its import hash is still a valid baseline.
UPDATE originals SET verified_hash = content_hash
WHERE kind = 'raw' AND lower(ref) !~ '\.dng$';

CREATE INDEX idx_originals_checked_at ON originals (checked_at NULLS FIRST);
CREATE INDEX idx_originals_health ON originals (user_id, health) WHERE health IS NOT NULL;
```

A row with `verified_hash` set but `verified_mtime` NULL (only the seeded RAWs) is compared by hash
alone on its first check; any other row without a baseline just adopts the current file.

## Risks

- Corruption that also bumps the mtime (a sync tool rewriting files badly, ransomware) is treated
  as an edit and missed. Accepted for simplicity.
- An editor that preserves mtime (`exiftool -P`) raises a false "changed"; Ignore resolves it.
- `reorganizeOriginals.ts` falls back to `copyFile` across drives, which drops the mtime, so a
  cross-drive reorganize quietly re-baselines and can't catch a bad copy. Fix: `utimes` after copy.
- Files with `volume_id` NULL on an unplugged, unregistered drive rely on the "folder gone" rule
  to avoid false "Missing" rows.
- Reading 20 TB wears drives slightly and spins up sleeping disks; the throttle and 90-day cycle
  keep it modest.

## Decisions

1. Cycle: fixed 90 days, no setting. Missing, unreadable and ignored files are looked at again
   daily, so a file that comes back clears soon.
2. Throttle: fixed 50 MB/s, as a pause after each file.
3. Ignore on a Missing (or unreadable) file clears itself once the file is readable again.
4. The server build shows the same Settings row. Reveal in Finder there works when the desktop app
   finds the server's share mounted on the Mac (`server_paths.rs`), otherwise Copy path.
5. Files `trips/scan.ts` marks `stale` are listed as Missing, in the same list. A check that finds
   one at its path clears `stale`.

## As built

- Migration 160; `originals/health.ts` (job, summary, list, Ignore); routes in `originals/routes.ts`.
- The pass waits while a trip, reimport, reorganize or library move runs, and for a minute after
  any import adds a file. It walks due rows by `(checked_at, id)`, so skipped files don't stall it.
- Every result write is guarded on `ref`, so a file moved mid-check isn't marked from its old path.
- `reorganizeOriginals.ts` keeps the mtime when it copies across drives.
- The switch and `lastFullPassAt` live in `install_settings` under `archive_health`.
