-- Where a capture row came from. 'local': imported on this install, with its original file.
-- 'mirror': a copy of a capture on the server this desktop app is linked to (sync/mirror.ts):
-- metadata and a small derivative only, no original, kept in step with the server and removed
-- when the server's row goes. Mirrored rows keep the server's ids, so the two installs agree on
-- what a capture is called.
ALTER TABLE captures_all ADD COLUMN origin text NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'mirror'));
CREATE INDEX captures_all_mirror_idx ON captures_all (user_id) WHERE origin = 'mirror';
