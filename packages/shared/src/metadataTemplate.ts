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
  "genus",
  "family",
  "order",
  "class",
  "focal",
  "aperture",
  "shutter",
  "iso",
  "longdate",
  "names",
  "count",
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

/** How a templated field is written when the file already has a value. */
export const WRITE_RULES = ["fillEmpty", "replace", "append", "off"] as const;
export type WriteRule = (typeof WRITE_RULES)[number];

export interface FieldTemplate {
  template: string;
  rule: WriteRule;
}

/** Templated Title, Headline, Caption and extra Keywords (comma separated), and which species a
 *  frame with several names in {names} and {count}. */
export interface MetadataFields {
  title: FieldTemplate;
  headline: FieldTemplate;
  caption: FieldTemplate;
  keywords: FieldTemplate;
  multiSpecies: "all" | "main";
}
export type TemplatedField = "title" | "headline" | "caption" | "keywords";
export const TEMPLATED_FIELDS: readonly TemplatedField[] = ["title", "headline", "caption", "keywords"];

// Equal to what Lifer wrote before templates: the title names every species in the naming style,
// a caption only when one is set, never a headline or extra keywords.
export const DEFAULT_METADATA_FIELDS: MetadataFields = {
  title: { template: "{names}", rule: "replace" },
  headline: { template: "", rule: "replace" },
  caption: { template: "", rule: "replace" },
  keywords: { template: "", rule: "replace" },
  multiSpecies: "all",
};

export const CAPTION_PRESETS = {
  place: "{species} ({scientific}), {place}, {region}, {date}",
  imageOf: "An image of a {species}[[ taken on {longdate}]][[ with a {focal} {aperture}]]",
} as const;

export interface RenderedFields {
  title: string;
  headline: string;
  caption: string;
  keywords: string[];
}

/** Extra keywords: each comma or semicolon separated part filled on its own, empties dropped. */
export function renderKeywords(template: string, values: TemplateValues): string[] {
  const out = template.split(/[,;]/).map((part) => renderTemplate(part, values));
  return [...new Set(out.filter(Boolean))];
}

export function renderFields(fields: MetadataFields, values: TemplateValues): RenderedFields {
  return {
    title: renderTemplate(fields.title.template, values),
    headline: renderTemplate(fields.headline.template, values),
    caption: renderTemplate(fields.caption.template, values),
    keywords: renderKeywords(fields.keywords.template, values),
  };
}

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

const valueOf = (values: TemplateValues, name: string) =>
  (values[name as FileNameVariable] ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// "[[ with a {focal}]]" is kept only when every variable in it has a value, so wording around a
// missing value goes with it.
const OPTIONAL = /\[\[(.*?)\]\]/g;
// "a" before a value that starts with a vowel sound reads "an" ("an Osprey"); "eu", "uni", "one"
// and the like start with a consonant sound.
const ARTICLE = /\b([Aa]) (\{[a-z]+\})/g;
const VOWEL_SOUND = /^(?![Ee]u|[Uu]ni|[Uu]s[aeiou]|[Uu]r[aeiou]|[Oo]ne)[AEIOUaeiou]/;

/** Fills a template. An empty value drops cleanly with its separator, and brackets left empty
 *  go too: "{species} ({scientific}), {place}" with no scientific name reads "Osprey, Lake".
 *  Unknown variables stay as typed. */
export function renderTemplate(template: string, values: TemplateValues): string {
  const known = (name: string) => (FILE_NAME_VARIABLES as readonly string[]).includes(name);
  let out = template
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, "")
    .replace(OPTIONAL, (_, inner: string) =>
      [...inner.matchAll(VARIABLE)].every((m) => known(m[1]) && valueOf(values, m[1])) ? inner : "",
    )
    .replace(ARTICLE, (whole, a: string, token: string) =>
      VOWEL_SOUND.test(valueOf(values, token.slice(1, -1))) ? `${a}n ${token}` : whole,
    )
    .replace(VARIABLE, (whole, name: string) => (known(name) ? valueOf(values, name) || EMPTY : whole));
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
