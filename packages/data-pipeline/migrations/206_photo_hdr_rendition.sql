-- Whether a photo has an HDR rendition (APP_DATA_DIR/hdr/<photo id>.jpg) for the viewer on an HDR
-- screen: NULL not looked at yet, 'none' its original has no HDR Lifer can show, 'ready' made. A
-- local cache flag like the derivative files it describes; the normal pipeline never reads it.
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS hdr_rendition text CHECK (hdr_rendition IN ('none', 'ready'));
