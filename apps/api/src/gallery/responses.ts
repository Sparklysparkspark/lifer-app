// Response schemas for the Gallery routes, and the photo shape albums and the command palette
// reuse. They document the answer in the OpenAPI document and type the web app's calls; fields not
// listed still pass through.
import { Type } from "typebox";
import { CULL_LABELS } from "@lifer/shared";
import { DateTime, NumberLike, Nullable, Open, Uuid } from "../lib/schema.js";

/** One photo (toGalleryItem in routes.ts). */
export const GalleryItem = Open({
  photoId: Uuid(),
  width: Nullable(Type.Integer()),
  height: Nullable(Type.Integer()),
  captureId: Uuid(),
  speciesId: Uuid(),
  scientificName: Type.String(),
  commonName: Nullable(Type.String()),
  taxonClass: Type.String(),
  takenAt: Nullable(DateTime()),
  cameraModel: Nullable(Type.String()),
  lens: Nullable(Type.String()),
  focalLengthMm: Nullable(NumberLike()),
  aperture: Nullable(NumberLike()),
  shutter: Nullable(Type.String()),
  iso: Nullable(Type.Integer()),
  qualityRating: Nullable(Type.Integer()),
  lat: Nullable(NumberLike()),
  lon: Nullable(NumberLike()),
  regionId: Nullable(Uuid()),
  regionName: Nullable(Type.String()),
  locationLabel: Nullable(Type.String({ description: "The place name under its region, e.g. a park" })),
  kind: Type.Enum(["image", "video", "audio"]),
  durationSeconds: Nullable(NumberLike()),
  tags: Type.Array(Type.String()),
  cullVerdict: Nullable(Type.Enum(["pick", "reject"])),
  cullLabel: Nullable(Type.Enum([...CULL_LABELS])),
  hidden: Type.Boolean({ description: "Imported hidden because a culling app rejected it" }),
  isFeatured: Nullable(Type.Boolean({ description: "Its species' cover photo (null when the species has none)" })),
  hasRawOriginal: Type.Boolean(),
  inatStatus: Nullable(
    Type.Enum(["pending", "completed"], {
      description: "Its iNaturalist observation: unfinished or complete; null when not sent",
    }),
  ),
  inatObservationId: Nullable(Type.String({ description: "The iNaturalist observation it was sent as" })),
  originalRef: Nullable(Type.String()),
  originalManaged: Nullable(Type.Boolean()),
  originalKind: Nullable(Type.String()),
  rawRef: Nullable(Type.String()),
  taxonOrder: Nullable(Type.String()),
  family: Nullable(Type.String()),
  sortOrder: Nullable(
    Type.Integer({ description: "The species' place in its published field guide sequence, where there is one" }),
  ),
  isOtherTaxa: Type.Boolean(),
  inatIconicTaxon: Nullable(Type.String()),
  tier: Nullable(Type.String({ description: "The species' rarity tier (the user's own if set)" })),
  localTier: Nullable(
    Type.String({
      description: "With a region filter: the species' tier in that region; null otherwise or when unknown",
    }),
  ),
  matchScore: Nullable(Type.Number({ description: "How well a search matched; null for the plain listing" })),
  frame: Type.Optional(
    Nullable(
      Type.Object(
        {
          box: Nullable(
            Type.Array(Type.Number(), {
              minItems: 4,
              maxItems: 4,
              description: "The detector's best animal box [x1, y1, x2, y2] as fractions of the upright photo",
            }),
          ),
          boxUnsure: Type.Boolean({ description: "The detector wasn't sure: a speck, or found only on a closer look" }),
          aspect: Type.Number({ description: "Upright width / height" }),
          orientation: Type.Enum(["horizontal", "vertical", "square"]),
          composition: Nullable(
            Type.Object(
              {
                size: Type.Enum(["tiny", "small", "medium", "frameFilling"], {
                  description: "Share of the frame the animal fills: under 1.5%, under 10%, under 35%, more",
                }),
                thirds: Type.Boolean({ description: "Centred on a rule-of-thirds intersection" }),
                goldenRatio: Type.Boolean({ description: "Centred on a golden ratio (phi grid) intersection" }),
                centred: Type.Boolean(),
              },
              { additionalProperties: true, description: "Where the animal sits; null without a sure box" },
            ),
          ),
          light: Type.Object(
            {
              luma: Type.Number({ description: "Mean brightness, 0 to 1" }),
              warmth: Type.Number({ description: "Mean red minus blue, -1 (cool) to 1 (warm)" }),
              highlights: Type.Number({ description: "Share of near-white pixels" }),
              shadows: Type.Number({ description: "Share of near-black pixels" }),
              saturation: Type.Number({ description: "Mean colourfulness, 0 to 1" }),
            },
            { additionalProperties: true, description: "The photo's own light" },
          ),
        },
        {
          additionalProperties: true,
          description: "Composition and light read from the photo; null until the background job reads it",
        },
      ),
    ),
  ),
  timeMaybeWrong: Type.Optional(
    Nullable(
      Type.Boolean({
        description:
          "The sun was well below the horizon at the photo's place and time, yet the photo is plainly daylit, so its time is probably wrong. Null when unknown, or for a sensitive species on a device key",
      }),
    ),
  ),
  version: Type.Optional(
    Type.Object(
      {
        of: Uuid({ description: "The photo this file is a version of" }),
        label: Nullable(Type.String({ description: "The name the user gave this version" })),
        labelKind: Type.Enum(["original", "edit", "export", "print", "bw", "pano", "enhanced", "hdr"]),
        labelSize: Nullable(Type.String()),
      },
      { description: "Only with allVersions=1, on a file listed apart from the photo it belongs to" },
    ),
  ),
});

/** How the server read a search query. */
export const SearchInterpretation = Open({
  species: Type.Array(Type.String()),
  groups: Type.Array(Type.String()),
  scenes: Type.Array(Type.String({ description: 'Scene and colour words read from the photo ("water", "purple")' })),
  places: Type.Array(Type.String()),
  dates: Type.Array(Type.String()),
  order: Type.Array(Type.String({ description: 'How results are ordered, e.g. "best first"' })),
  description: Nullable(Type.String()),
  count: Type.Optional(
    Nullable(
      Type.Object(
        {
          min: Type.Integer(),
          max: Nullable(Type.Integer()),
          about: Nullable(Type.Integer({ description: 'The rough number asked for ("about 50")' })),
          crowd: Type.Boolean({ description: "Too many to count: picture matches of a crowd count too" }),
        },
        { description: "How many animals the query asks for" },
      ),
    ),
  ),
  readings: Type.Optional(
    Type.Array(
      Type.Enum([
        "lifers",
        "legendary",
        "rare",
        "uncommon",
        "occasional",
        "common",
        "rarestFirst",
        "endemic",
        "unrated",
        "videos",
        "raw",
        "hidden",
        "edited",
        "noLocation",
        "noDate",
        "newestFirst",
        "oldestFirst",
        "flying",
        "behavior",
        "resting",
        "close",
        "environmental",
        "goldenHour",
        "blueHour",
        "twilight",
        "sunrise",
        "sunset",
        "night",
        "morning",
        "midday",
        "afternoon",
        "evening",
        "ruleOfThirds",
        "goldenRatio",
        "centred",
        "smallInFrame",
        "frameFilling",
        "vertical",
        "horizontal",
      ]),
      {
        description:
          'Filters, orders, times of day and composition asked for in words ("lifers", "sunset", "rule of thirds")',
      },
    ),
  ),
  stars: Type.Optional(
    Nullable(
      Type.Object(
        { min: Type.Integer(), max: Nullable(Type.Integer()) },
        { description: 'A star rating range asked for ("4+ stars")' },
      ),
    ),
  ),
  styles: Type.Optional(Type.Array(Type.String({ description: 'Photo styles, as typed ("high key", "bokeh")' }))),
  excluded: Type.Optional(
    Type.Array(Type.String({ description: 'What "not" or "without" leaves out ("mallards", "people")' })),
  ),
  cameras: Type.Optional(Type.Array(Type.String({ description: "Camera models the query named" }))),
  backgrounds: Type.Optional(
    Type.Array(Type.String({ description: 'What\'s asked for behind the animal ("tree", "sky")' })),
  ),
  parts: Type.Optional(
    Type.Array(
      Open({
        kind: Type.Enum([
          "species",
          "group",
          "count",
          "scene",
          "light",
          "composition",
          "background",
          "style",
          "description",
          "place",
          "date",
          "filter",
          "camera",
          "excluded",
        ]),
        label: Type.String({ description: "What it was read as" }),
        text: Type.String({ description: "The words typed for it (lowercased), to take out of the query" }),
        exact: Type.Boolean({
          description: 'Answered from stored facts; false: a best guess from the picture model ("probably")',
        }),
      }),
      { description: "The query split into its parts, in the order typed" },
    ),
  ),
});

/** GET /gallery/similar: groups of near-identical photos, largest first. */
export const SimilarGroupList = Open({
  total: Type.Integer({ description: "Groups in all" }),
  groups: Type.Array(
    Open({
      captureId: Uuid({ description: "The group's first photo: pass it as similarTo to list the group" }),
      count: Type.Integer(),
      speciesId: Uuid(),
      commonName: Nullable(Type.String()),
      scientificName: Type.String(),
      firstTakenAt: Nullable(DateTime()),
      lastTakenAt: Nullable(DateTime()),
      previewPhotoIds: Type.Array(Uuid(), { description: "The first few photos, in time order" }),
    }),
  ),
});
