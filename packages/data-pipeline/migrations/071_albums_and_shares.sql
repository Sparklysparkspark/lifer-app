-- Albums: a manually-curated, named collection of captures — same shape as `trips` (a name plus
-- an ordered set of captures) but user-curated instead of auto-populated by folder-scan
-- fingerprint matching. A capture can belong to any number of albums.
CREATE TABLE albums (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  description    text NULL,
  cover_photo_id uuid NULL REFERENCES photos(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_albums_user ON albums (user_id);

-- References captures_all, not the `captures` view (see 061_captures_trash.sql) — a soft-deleted
-- capture still needs its FK target to exist; routes.ts filters trashed captures out of album
-- reads explicitly instead.
CREATE TABLE album_captures (
  album_id   uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, capture_id)
);

-- A public, revocable link onto one album's current contents (read live at request time — see
-- apps/api/src/shares/routes.ts — not a frozen snapshot of what was in the album when the link
-- was created). Server/self-hosted mode only: the frontend never surfaces the "Share" UI in
-- desktop mode (see useDesktopMode.ts), since SINGLE_USER_MODE has no real session system to
-- protect the owner-side management endpoints and there's no public URL to hand out anyway.
CREATE TABLE shared_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id       uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  token          text NOT NULL UNIQUE,
  password_hash  text NULL,
  allow_download boolean NOT NULL DEFAULT false,
  -- Camera EXIF only (lens/aperture/shutter/iso) — GPS is never included in any public response
  -- regardless of this flag; see shares/routes.ts's own comment on why that one is non-negotiable.
  show_metadata  boolean NOT NULL DEFAULT false,
  expires_at     timestamptz NULL,
  revoked_at     timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_shared_links_album ON shared_links (album_id);
