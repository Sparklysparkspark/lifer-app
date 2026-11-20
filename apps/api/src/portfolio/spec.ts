import { Type, type Static } from "typebox";
import { Uuid } from "../lib/schema.js";

/** What goes into the portfolio: photos of chosen albums, the best photo of chosen species, and
 *  optionally the life list. */
export const PortfolioSpec = Type.Object(
  {
    title: Type.String({ maxLength: 200 }),
    albumIds: Type.Array(Uuid(), { maxItems: 200 }),
    speciesIds: Type.Array(Uuid(), { maxItems: 5000 }),
    lifeList: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type PortfolioSpec = Static<typeof PortfolioSpec>;

export const EMPTY_SPEC: PortfolioSpec = { title: "", albumIds: [], speciesIds: [], lifeList: true };
