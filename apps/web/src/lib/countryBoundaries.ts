import type { CountryBoundary } from "../components/PacksMap";
import { createCachedResource } from "./resource";

// Every country's outline, about 4.5 MB: fetched once per launch and shared by every map that
// needs it. A failed fetch isn't cached, so the next screen to ask tries again.
export const countryBoundariesResource = createCachedResource<CountryBoundary[], { regions: CountryBoundary[] }>(
  "/regions/boundaries?level=country",
  (raw) => raw.regions,
);
