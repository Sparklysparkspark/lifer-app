-- Marks that the lazy on-demand gallery fetch (apps/api/src/species/lazyGallery.ts) has
-- already been attempted for this species, regardless of whether it found any usable
-- photos — without this, a species with no Wikipedia article (or no acceptable photos)
-- would re-attempt the fetch on every single detail-page view.
ALTER TABLE species ADD COLUMN gallery_fetched_at timestamptz NULL;
