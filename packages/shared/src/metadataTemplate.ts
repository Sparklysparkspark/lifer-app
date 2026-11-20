// Caption, copyright and file name templates ("{species}, {place}, {date}"), filled per photo.
// Shared so Settings' live preview renders exactly what the API writes.

export const TEMPLATE_VARIABLES = [
  "species",
  "scientific",
  "group",
  "place",
  "region",
  "country",
  "date",
  "year",
  "month",
  "trip",
  "camera",
  "lens",
  "rating",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** File names also take a running number and the camera's own file name. */
export const FILE_NAME_VARIABLES = [...TEMPLATE_VARIABLES, "seq", "original"] as const;
export type FileNameVariable = (typeof FILE_NAME_VARIABLES)[number];

export type TemplateValues = Partial<Record<FileNameVariable, string | null>>;

/** The per-user copyright and caption settings ("stationery pad"). Empty fields write nothing. */
export interface MetadataTemplate {
  creator: string;
  copyright: string;
  credit: string;
  usageTerms: string;
  caption: string;
  /** Write creator, copyright, credit and usage terms over what a file already has. */
  replaceExisting: boolean;
}

export const DEFAULT_METADATA_TEMPLATE: MetadataTemplate = {
  creator: "",
  copyright: "",
  credit: "",
  usageTerms: "",
  caption: "",
  replaceExisting: false,
};

export const FILE_NAME_PRESETS = {
  original: "{original}",
  dateSpecies: "{date}_{species}_{seq}",
  speciesDate: "{species}_{date}_{seq}",
} as const;
export type FileNamePreset = keyof typeof FILE_NAME_PRESETS;
export const DEFAULT_FILE_NAME_TEMPLATE: string = FILE_NAME_PRESETS.original;

export function fileNamePreset(template: string): FileNamePreset | "custom" {
  const hit = Object.entries(FILE_NAME_PRESETS).find(([, t]) => t === template.trim());
  return hit ? (hit[0] as FileNamePreset) : "custom";
}

/** True when files keep the camera's name, which is how Lifer names them by default. */
export const keepsOriginalName = (template: string) => {
  const t = template.trim();
  return t === "" || t === FILE_NAME_PRESETS.original;
};

const VARIABLE = /\{([a-z]+)\}/g;

/** Variable names a template uses that aren't in `allowed`, for validation. */
export function unknownTemplateVariables(template: string, allowed: readonly string[] = FILE_NAME_VARIABLES): string[] {
  return [...template.matchAll(VARIABLE)].map((m) => m[1]).filter((v) => !allowed.includes(v));
}

// Marks an empty value while cleaning up; never in a real value (control characters are dropped).
const EMPTY = "\u0000";
const SEP = String.raw`[\s,;:_\-|/·]`;
const EMPTY_GROUP = new RegExp(String.raw`[(\[]${SEP}*\u0000(?:${SEP}|\u0000)*[)\]]`, "g");
const LEADING_EMPTY = new RegExp(String.raw`^(?:${SEP}|\u0000)*\u0000${SEP}*`);
const EMPTY_WITH_SEP = new RegExp(String.raw`${SEP}*\u0000`, "g");

/** Fills a template. An empty value drops cleanly with its separator, and brackets left empty
 *  go too: "{species} ({scientific}), {place}" with no scientific name reads "Osprey, Lake".
 *  Unknown variables stay as typed. */
export function renderTemplate(template: string, values: TemplateValues): string {
  // eslint-disable-next-line no-control-regex
  let out = template.replace(/\u0000/g, "").replace(VARIABLE, (whole, name: string) => {
    if (!(FILE_NAME_VARIABLES as readonly string[]).includes(name)) return whole;
    // eslint-disable-next-line no-control-regex
    const v = (values[name as FileNameVariable] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
    return v.trim() || EMPTY;
  });
  let prev: string;
  do {
    prev = out;
    out = out.replace(EMPTY_GROUP, EMPTY);
  } while (out !== prev);
  out = out.replace(LEADING_EMPTY, "").replace(EMPTY_WITH_SEP, "");
  out = out.replace(/\s+/g, " ").trim();
  // Only punctuation left: no caption beats a lone "." or "()".
  return /[\p{L}\p{N}]/u.test(out) ? out : "";
}
