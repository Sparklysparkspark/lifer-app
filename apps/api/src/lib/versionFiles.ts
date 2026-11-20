/** SQL for the capture whose files are capture `c`'s current photo. "Use this as the photo" swaps
 *  photo rows between a group and its shown version (uploads/versionGrouping.ts), so Reveal, Open
 *  in and the file names follow the photo on screen, not the capture it now sits on. */
export const filesCaptureOf = (c: string) => `COALESCE(
  (SELECT vf.capture_id FROM capture_versions vf WHERE vf.group_capture_id = ${c}.id AND vf.state = 'linked' AND vf.displayed),
  (SELECT vf.group_capture_id FROM capture_versions vf WHERE vf.capture_id = ${c}.id AND vf.state = 'linked' AND vf.displayed),
  ${c}.id)`;
