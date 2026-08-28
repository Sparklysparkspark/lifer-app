ALTER TABLE storage_volumes ADD COLUMN is_default boolean NOT NULL DEFAULT false;

-- Only one default volume per user — enforced as a partial unique index (false rows aren't unique).
CREATE UNIQUE INDEX storage_volumes_one_default_per_user ON storage_volumes (user_id) WHERE is_default;
