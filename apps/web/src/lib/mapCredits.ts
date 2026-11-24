import type { Map as MapLibreMap } from "maplibre-gl";
import {
  DETAIL_SOURCE_ID,
  LANDCOVER_SOURCE_ID,
  MAPTERHORN,
  OFFLINE_DETAIL_PREFIX,
  ONLINE_PROVIDERS,
  ONLINE_RELIEF_SOURCE_ID,
  PMTILES_SOURCE_ID,
  RELIEF_SOURCE_ID,
  SATELLITE_SOURCE_ID,
} from "./mapStyle";

// Every map has a credits button listing each source's full citation, the ones on screen first
// (docs/plans/map-detail-and-satellite.md has what each provider requires). Licence text is kept as
// data, untranslated, exactly as the providers ask.

export type CreditKey = "osm" | "protomaps" | "terrain" | "mapterhorn" | "openfreemap" | "eox" | "imagery" | "photon";

export interface Credit {
  key: CreditKey;
  name: string;
  text: string;
  href: string;
  /** Notices that must appear in full (Terrain Tiles' sources). */
  lines?: string[];
  licence?: { name: string; href: string };
}

// Required by the Terrain Tiles data providers, from tilezen/joerd's attribution list.
const TERRAIN_NOTICES = [
  "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736.",
  "Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017.",
  "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich.",
  "Canada terrain data contains information licensed under the Open Government Licence – Canada.",
  "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers.",
  "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration.",
  "Mexico terrain data source: INEGI, Continental relief, 2016.",
  "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved).",
  "Norway terrain data © Kartverket.",
  "United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved.",
  "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.",
];

/** The credit OpenStreetMap asks to see on the map itself. */
export const OSM_CREDIT = "© OpenStreetMap contributors";

const CREDITS_PAGE = "https://sparklysparkspark.github.io/lifer-app/credits#maps-and-regions";

const FULL: Record<Exclude<CreditKey, "imagery">, Credit> = {
  osm: {
    key: "osm",
    name: "OpenStreetMap",
    text: "Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).",
    href: "https://www.openstreetmap.org/copyright",
  },
  protomaps: {
    key: "protomaps",
    name: "Protomaps and Natural Earth",
    text: "The offline map is a Protomaps basemap (BSD-3-Clause) built from OpenStreetMap data, with Natural Earth (public domain) at world zoom.",
    href: "https://protomaps.com",
  },
  terrain: {
    key: "terrain",
    name: "Terrain Tiles",
    text: "Shaded relief from the Terrain Tiles composite (Mapzen, on AWS Open Data), with these notices from its sources (also on Lifer's credits page):",
    href: CREDITS_PAGE,
    lines: TERRAIN_NOTICES,
  },
  mapterhorn: {
    key: "mapterhorn",
    name: MAPTERHORN.name,
    // Mapterhorn adds no licence of its own; its sources' notices live on the linked page.
    text: "Sharper online relief from Mapterhorn, built from open elevation data. Its sources and their notices are listed on Mapterhorn's attribution page.",
    href: "https://mapterhorn.com/attribution",
  },
  openfreemap: {
    key: "openfreemap",
    name: "OpenFreeMap",
    text: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap.",
    href: "https://openfreemap.org",
  },
  eox: {
    key: "eox",
    name: "EOxCloudless 2025",
    // EOX's own attribution sentence, word for word.
    text: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)",
    href: "https://cloudless.eox.at",
    licence: { name: "CC BY-NC-SA 4.0", href: "https://creativecommons.org/licenses/by-nc-sa/4.0/" },
  },
  photon: {
    key: "photon",
    name: "Photon",
    text: "Place search by Photon (komoot), with OpenStreetMap data © OpenStreetMap contributors (ODbL).",
    href: "https://photon.komoot.io",
  },
};

function imageryCredit(tiles: string): Credit {
  const host = new URL(tiles.replace(/[{}]/g, "")).host;
  return {
    key: "imagery",
    name: host,
    text: `Satellite imagery from ${host}, under that provider's terms.`,
    href: `https://${host}`,
  };
}

type Layer = { source?: string; minzoom?: number; maxzoom?: number; layout?: { visibility?: string } };
type Source = { tiles?: string[] };

/** The credits for what the map shows right now: sources with a layer drawn at this zoom. The
 *  bundled map's credits drop while satellite imagery covers it. */
export function activeCredits(map: MapLibreMap, { placeSearch = false } = {}): Credit[] {
  const style = map.getStyle?.();
  const zoom = map.getZoom();
  const shown = new Set(
    ((style?.layers ?? []) as Layer[])
      .filter((l) => l.layout?.visibility !== "none" && zoom >= (l.minzoom ?? 0) && zoom < (l.maxzoom ?? 25))
      .map((l) => l.source),
  );
  const satellite = shown.has(SATELLITE_SOURCE_ID);
  const keys = new Set<CreditKey>();
  const offlineDetail = [...shown].some((s) => s?.startsWith(OFFLINE_DETAIL_PREFIX));
  if (!satellite && (shown.has(PMTILES_SOURCE_ID) || shown.has(LANDCOVER_SOURCE_ID) || offlineDetail))
    keys.add("osm").add("protomaps");
  if (!satellite && shown.has(RELIEF_SOURCE_ID)) keys.add("terrain");
  if (!satellite && shown.has(ONLINE_RELIEF_SOURCE_ID)) keys.add("mapterhorn");
  if (shown.has(DETAIL_SOURCE_ID)) keys.add("osm").add("openfreemap");
  const credits = (["terrain", "mapterhorn", "osm", "openfreemap", "protomaps"] as const)
    .filter((k) => keys.has(k))
    .map((k) => FULL[k]);
  // Imagery first: its credit is the one a satellite view must show at the top.
  if (satellite) {
    const tiles = (style?.sources?.[SATELLITE_SOURCE_ID] as Source | undefined)?.tiles?.[0] ?? "";
    credits.unshift(
      tiles && !tiles.startsWith(ONLINE_PROVIDERS.satellite.tiles.split("/wmts")[0]) ? imageryCredit(tiles) : FULL.eox,
    );
  }
  if (placeSearch) credits.push(FULL.photon);
  return credits;
}

/** The other sources this map can show (offline relief, online detail, satellite), listed after
 *  the active ones so every licence stays one click away. */
export function alsoUsedCredits(active: Credit[]): Credit[] {
  const shown = new Set(active.map((c) => c.key));
  return (["osm", "protomaps", "terrain", "mapterhorn", "openfreemap", "eox"] as const)
    .filter((k) => !shown.has(k) && !(k === "eox" && shown.has("imagery")))
    .map((k) => FULL[k]);
}

/** Where a map control's panel goes on the page: against its button, on the preferred side (above
 *  for the credits in a bottom corner, below for the layers in a top corner) when there's room, else
 *  the roomier side, always inside the window with a margin and scrolling inside when short.
 *  Viewport coordinates, for a fixed, portaled panel, so a small map or dialog never clips it. */
export function mapPanelBox(
  button: { left: number; top: number; right: number; bottom: number },
  view: { width: number; height: number },
  { width = 320, margin = 8, gap = 4, minHeight = 160, prefer = "above" as "above" | "below" } = {},
): { left: number; width: number; maxHeight: number; top?: number; bottom?: number } {
  const w = Math.min(width, view.width - 2 * margin);
  const left = Math.max(margin, Math.min(button.right - w, view.width - margin - w));
  const above = button.top - gap - margin;
  const below = view.height - button.bottom - gap - margin;
  const up = prefer === "above" ? above >= minHeight || above >= below : below < minHeight && above > below;
  if (up) return { left, width: w, bottom: view.height - button.top + gap, maxHeight: Math.max(0, above) };
  return { left, width: w, top: button.bottom + gap, maxHeight: Math.max(0, below) };
}
