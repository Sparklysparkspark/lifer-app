-- A date typed for a photo with no capture time (or copied from iNaturalist) was stored as midnight
-- UTC, which reads as the day before west of UTC. Noon UTC reads as that day from UTC-12 to UTC+11.
-- Only photos with no EXIF capture time are touched: a camera's time always has a fingerprint.
UPDATE captures_all
   SET taken_at = taken_at + interval '12 hours'
 WHERE taken_at IS NOT NULL
   AND exif_fingerprint IS NULL
   AND exif_fingerprint_loose IS NULL
   AND (taken_at AT TIME ZONE 'UTC')::time = TIME '00:00:00';
