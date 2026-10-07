// Applies the photo license policy (pipeline/photoLicensePolicy.ts) to the database once. The
// enrich stage already does this; run it by hand after editing photos directly, then run the
// vectors stage so replaced main photos get new vectors.
//
// Usage: npm run apply-photo-licenses -w data-pipeline
import { pool } from "../db.js";
import { applyPhotoLicensePolicy } from "../pipeline/photoLicensePolicy.js";

try {
  await applyPhotoLicensePolicy(pool);
} finally {
  await pool.end();
}
