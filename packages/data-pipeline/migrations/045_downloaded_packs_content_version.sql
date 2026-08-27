-- Lets a client detect a stale downloaded pack — dedup used to be purely "have I ever
-- downloaded this pack id" (see offlinePacks/routes.ts), with no way to notice the pack's
-- upstream content changed since. Nullable: no pack has ever actually been downloaded anywhere
-- yet (PACK_INDEX_URL has never been configured), so there's nothing to backfill.
ALTER TABLE downloaded_packs ADD COLUMN content_version text NULL;
