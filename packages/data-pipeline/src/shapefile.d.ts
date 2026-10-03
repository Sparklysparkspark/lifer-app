// No @types/shapefile exists. Only the `read` function (shp+dbf -> GeoJSON FeatureCollection)
// is used, so only that is declared.
declare module "shapefile" {
  export function read(shp: string, dbf?: string): Promise<{ type: "FeatureCollection"; features: unknown[] }>;
}
