// Response schemas for the import routes. They document the answer in the OpenAPI document and
// type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { Open } from "../lib/schema.js";

// EbirdImportSummary in @lifer/shared region-api.ts.
export const EbirdImportSummary = Open({
  totalRows: Type.Integer(),
  uniqueSpecies: Type.Integer(),
  matched: Type.Integer(),
  alreadySeenOrCollected: Type.Integer(),
  unmatched: Type.Integer(),
});
