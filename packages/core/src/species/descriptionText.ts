// The species description rule, shared by every path that writes species.description: the
// pipeline's Wikipedia backfill (data-pipeline backfill-descriptions.ts and
// fetch-wikipedia-summary.ts) and the on-view iNaturalist path (lazyEnrich.ts).
//
// The rule picks content, not a sentence count. It keeps what helps someone in the field:
// identification (size, colours, markings, look-alikes) and notable behaviour or ecology. It drops
// boilerplate the species page already shows or that rarely helps:
//   - taxonomy ("is a species of X in the family Y", subspecies, "was formerly placed in"),
//   - etymology and naming history,
//   - synonym and alternative-name lists,
//   - range sentences that are mostly place names (the map and checklists cover range),
//   - conservation-status lines (the IUCN badge covers them).
// Sources, in order: the article's lead, then its Description (or Identification, Appearance,
// Morphology) section. When both have something, the lead gets at most
// DESCRIPTION_MAX_CHARS minus what the section needs (up to half), so identification text always
// has room. Text is cut only between whole sentences, never inside one, and nothing marks the
// cut: the "(Wikipedia)" link beside it is the "read more". A trailing fragment a source cut off
// mid-sentence (iNaturalist's summaries end in "...") is dropped. A stub whose only sentence is
// taxonomy still gets that sentence, so a species with an article never ends up with nothing.
//
// Everything here is deterministic and rule-based, no network, so it is unit-tested on real
// articles (__fixtures__/descriptionArticles.json).

/** The safety ceiling on a description's length, in characters. Sized for the species page: a
 *  lead sentence plus three or four identification sentences (Description sentences with
 *  measurements run 150 to 250 characters), about 120 to 140 words, which reads in one glance
 *  on a phone. Not a target: most species have less worth keeping. */
export const DESCRIPTION_MAX_CHARS = 800;

/** Section headings (lowercased, matched as whole words) that hold identification text. */
export const IDENTIFICATION_HEADINGS = ["description", "identification", "appearance", "morphology", "characteristics"];

export type SentenceKind =
  "taxonomy" | "etymology" | "synonyms" | "range" | "conservation" | "identification" | "ecology" | "other";

/** Kinds a description drops. */
export const BOILERPLATE_KINDS: ReadonlySet<SentenceKind> = new Set([
  "taxonomy",
  "etymology",
  "synonyms",
  "range",
  "conservation",
]);

const CONSERVATION =
  /\b(IUCN|Red List|least concern|near[- ]threatened|critically endangered|data deficient|conservation status|CITES|(listed|classified|assessed|evaluated|categori[sz]ed) as (being )?(vulnerable|endangered|threatened|least concern|near threatened|critically))/i;
// "Named for the venomous quills on its dorsal fin" is identification; "named after John Smith"
// isn't. So "named for/after" alone only counts as etymology without an identification cue.
const NAMED_FOR = /\bnamed (after|for)\b/i;
const ETYMOLOGY =
  /\b(etymolog\w*|named in hono(u)?r|in hono(u)?r of|(specific|generic|subspecific) (name|epithet)|epithet|eponym\w*|(derives?|derived|comes?) from the (Latin|Greek|Ancient Greek)|from (the )?(Latin|Ancient Greek|Greek) (word|words|for)|meaning ")/i;
const SYNONYMS =
  /\b(synonym\w*|(also|variously|sometimes|commonly|locally|alternatively|formerly|previously|generally|often|colloquially) (known as|called|referred to as|named)|(other|regional|local|vernacular|alternative) (common )?names?|is known by|common names? (include|are))\b/i;
const TAXONOMY = new RegExp(
  [
    // "is a species of snake", "is one of three species of tree squirrels", "is a species of marine ray-finned fish"
    String.raw`\b(is|was|are|were) (a|an|the|one of (the )?[\w-]+)( [\w-]+){0,3} (species|genus|subspecies) (of|in|within|belonging|from)\b`,
    String.raw`\bsubspecies\b`,
    String.raw`\b(first|originally|formally|formerly|scientifically) (described|catalogued|named|placed|classified)\b`,
    String.raw`\bdescribed (by|in) (\d{4}|[A-Z]\.|[A-Z][a-z]+ [A-Z][a-z]+)`,
    String.raw`\b(formerly|previously|once|long) (placed|classified|considered|treated|regarded|included)\b`,
    String.raw`\bconspecific\b`,
    String.raw`\bphylogen\w*`,
    String.raw`\bclade\b`,
    String.raw`\btaxonom\w*`,
    String.raw`\bclassified (in|as|under|within)\b`,
    String.raw`\bmonotypic\b`,
    String.raw`\btype (species|locality|specimen|genus)\b`,
    String.raw`\bsister (species|taxon|taxa|group)\b`,
    String.raw`\bsuperspecies\b`,
    String.raw`\bcongener\w*`,
    String.raw`\b(separate|distinct|recogni[sz]ed|valid|full) species\b`,
    String.raw`\bgenus [A-Z]\w+ (contains|includes|comprises)\b`,
    String.raw`\bbinomial\b`,
    String.raw`\btaxon\b`,
    String.raw`\b(correct|valid|accepted|current) scientific name\b`,
    String.raw`\b(split|lumped) (into|with)\b`,
  ].join("|"),
  "i",
);
// "A marine gastropod mollusk in the Rissoidae family": a Latin family, order or genus name with
// nothing else to say counts as taxonomy too.
const LATIN_GROUP =
  /\b(in the |of the )?((sub)?family|order|genus|tribe) [A-Z][a-z]+\b|\b[A-Z][a-z]+(idae|inae|formes|oidea) (sub)?family\b/;
const RANGE_CUE =
  /\b(lives? (mostly |mainly |primarily |chiefly )?(in|along|around|off) the|native to|indigenous to|endemic to|(found|occurs?|occurring|distributed|recorded|known|reported) (in|on|across|throughout|from|along|off|around)|distribution|range (includes|extends|covers|is)|ranges? (from|across|throughout|into|over|extends?)|ranging from|vagrant|breeds? (in|on|across|throughout)|winters? (in|on)|migrates? to)\b/i;
const IDENTIFICATION =
  /(\b\d+([.,]\d+)?\s?(–|-|to)?\s?(\d+([.,]\d+)?)?\s?(mm|cm|m|km|in|ft|kg|g|lb|oz|inches|feet|metres|meters|centimetres|centimeters|millimetres|grams|kilograms|pounds|ounces)\b|\b(colou?r\w*|plumage|stripe[sd]?|spot(s|ted)?|band(s|ed)?|bars?|barred|markings?|patterns?|mottled|speckled|white|black|brown|gr[ae]y|red|reddish|yellow\w*|green\w*|blue|bluish|orange|pale|dark|rusty|bill|beak|crest|fins?|scales?|fur|coat|tail|wings?|wingspan|plumes?|feathers?|shell|carapace|distinguish\w*|differs?|differing|similar|resembl\w*|look-?alike|larger|smaller|largest|smallest|large|small|length|long|tall|height|weigh\w*|mass|size|sexes|dimorph\w*|juveniles?|adults?|males?|females?)\b)/i;
const ECOLOGY =
  /\b(feeds?|feeding|fed|diet|eats?|eating|prey|preys|forag\w*|hunts?|hunting|breed\w*|nests?|nesting|spawn\w*|lays?|eggs?|young|viviparous|oviparous|nocturnal|diurnal|crepuscular|solitary|social|colon(y|ies|ial)|flocks?|schools?|territor\w*|migrat\w*|hibernat\w*|burrow\w*|habitat|dwells?|lives?|living|inhabits?|venom\w*|toxic|poison\w*|calls?|song|sings?|behaviou?r\w*|predators?|parasit\w*|symbio\w*|pollinat\w*|lifespan)\b/i;

// Words that look like proper nouns but aren't places (sentence starts are skipped separately).
const NOT_PLACE = new Set([
  "The",
  "It",
  "Its",
  "This",
  "These",
  "They",
  "Their",
  "A",
  "An",
  "In",
  "On",
  "Its",
  "I",
  "Some",
  "Most",
  "Many",
]);

/** Capitalized words outside parentheses, after the first word: a rough count of place names. */
function properNounCount(sentence: string): { proper: number; words: number } {
  const outside = sentence.replace(/\([^)]*\)/g, " ");
  const words = outside.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  let proper = 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (/^\p{Lu}\p{Ll}/u.test(w) && !NOT_PLACE.has(w)) proper++;
  }
  return { proper, words: words.length };
}

/** What one sentence is about. Boilerplate kinds are checked first, so "a subspecies of it"
 *  makes a sentence taxonomy even when it also mentions a colour. A range sentence is one with a
 *  range cue and two or more place names, unless it also carries identification and isn't
 *  mostly place names (under 30% of its words). */
export function classifySentence(sentence: string): SentenceKind {
  if (CONSERVATION.test(sentence)) return "conservation";
  if (ETYMOLOGY.test(sentence)) return "etymology";
  if (SYNONYMS.test(sentence)) return "synonyms";
  if (TAXONOMY.test(sentence)) return "taxonomy";
  const identification = IDENTIFICATION.test(sentence);
  const ecology = ECOLOGY.test(sentence);
  if (NAMED_FOR.test(sentence) && !identification) return "etymology";
  const { proper, words } = properNounCount(sentence);
  const mostlyPlaces = proper >= 2 && proper / Math.max(words, 1) >= 0.3;
  if (RANGE_CUE.test(sentence) && proper >= 2 && (!identification || mostlyPlaces)) return "range";
  // A list of places with no range verb ("important in Louisiana, the Carolinas, Delaware and
  // New Jersey") reads the same.
  if (mostlyPlaces && proper >= 4) return "range";
  if (LATIN_GROUP.test(sentence) && !identification && !ecology) return "taxonomy";
  if (identification) return "identification";
  if (ecology) return "ecology";
  return "other";
}

const DECIMAL = "\u0000D\u0000";
const ABBREV = "\u0000A\u0000";
// Abbreviations whose period never ends a sentence here.
const ABBREVIATIONS = [
  "e.g.",
  "i.e.",
  "c.",
  "ca.",
  "approx.",
  "St.",
  "Mt.",
  "Dr.",
  "No.",
  "vs.",
  "sp.",
  "spp.",
  "var.",
  "subsp.",
  "ssp.",
  "cf.",
  "Jr.",
  "Sr.",
  "U.S.",
  "U.K.",
  "fig.",
  "Fig.",
  "al.",
];
// Whole words only, so "c." never matches the end of "Pacific.".
const ABBREVIATION_PATTERN = new RegExp(
  `(?<![\\p{L}.])(${ABBREVIATIONS.map((a) => a.replace(/\./g, "\\.")).join("|")})`,
  "gu",
);

/** Splits text into sentences: on ., ! or ? followed by whitespace and a capital, digit or
 *  opening bracket, and at every line break. Decimals ("5.3 oz"), initials ("T. douglasii",
 *  "J. E. Gray") and common abbreviations don't end a sentence. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let marked = paragraph.replace(/\s+/g, " ").trim();
    if (!marked) continue;
    marked = marked.replace(/(\d)\.(\d)/g, `$1${DECIMAL}$2`);
    marked = marked.replace(ABBREVIATION_PATTERN, (abbr) => abbr.replace(/\./g, ABBREV));
    // A single capital letter and a period is an initial ("T. douglasii").
    marked = marked.replace(/(^|[\s(])(\p{Lu})\.(?=\s)/gu, `$1$2${ABBREV}`);
    for (const s of marked.split(/(?<=[.!?]["')\]]?)\s+(?=["'([]?[\p{Lu}\d])/u)) {
      const restored = s.split(DECIMAL).join(".").split(ABBREV).join(".").trim();
      if (restored) out.push(restored);
    }
  }
  return out;
}

/** Tidies plain-text extract artifacts: the empty or punctuation-only brackets left where
 *  pronunciations and audio links were, doubled spaces, and spaces before punctuation. */
export function cleanExtractText(text: string): string {
  return (
    text
      .replace(/\u00a0/g, " ")
      // Pronunciation leftovers: "(or US:, Procyon lotor)", "(UK: ; ...)".
      .replace(/\b(UK|US|American English|British English):\s*[,;]?\s*/g, "")
      .replace(/\(or ,?\s*/g, "(")
      .replace(/\(\s*[;,:]?\s*\)/g, "")
      .replace(/\(\s*[;,]\s*/g, "(")
      .replace(/[ \t]+/g, " ")
      .replace(/ +([,.;:!?)])/g, "$1")
      .replace(/\( +/g, "(")
      .trim()
  );
}

export interface ArticleSection {
  /** Lowercased heading; "" for the lead. */
  heading: string;
  /** 1 for the lead, 2 for "== X ==", 3 for "=== X ===". */
  level: number;
  /** The text under the heading, up to the next heading of any level. */
  body: string;
}

/** Splits a plain-text extract fetched with exsectionformat=wiki ("== Heading ==") into its
 *  lead and sections. */
export function splitSections(extract: string): ArticleSection[] {
  const sections: ArticleSection[] = [];
  const headingPattern = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
  let lastIndex = 0;
  let heading = "";
  let level = 1;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(extract))) {
    sections.push({ heading, level, body: extract.slice(lastIndex, match.index).trim() });
    heading = match[2].trim().toLowerCase();
    level = match[1].length;
    lastIndex = headingPattern.lastIndex;
  }
  sections.push({ heading, level, body: extract.slice(lastIndex).trim() });
  return sections;
}

/** The body of the first non-empty section whose heading contains one of `headings` as a whole
 *  word ("Anatomy and description" matches "description"), or null. */
export function findSection(sections: ArticleSection[], headings: readonly string[]): string | null {
  for (const s of sections) {
    if (!s.heading || !s.body) continue;
    const words = s.heading.split(/[^\p{L}]+/u);
    if (headings.some((h) => words.includes(h))) return s.body;
  }
  return null;
}

/** Whole sentences, in order, while they fit within maxChars (joined with single spaces). Stops
 *  at the first that doesn't fit rather than skipping it, so the text never jumps. */
export function takeWithinBudget(sentences: string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const cost = (out.length ? 1 : 0) + s.length;
    if (used + cost > maxChars) break;
    out.push(s);
    used += cost;
  }
  return out;
}

/** The sentences of `text` that `keep` accepts. */
export function filterSentences(text: string, keep: (sentence: string, kind: SentenceKind) => boolean): string[] {
  return splitSentences(cleanExtractText(text)).filter((s) => keep(s, classifySentence(s)));
}

const PRONOUN_START = /^(It|Its|They|Their|This|These|He|She|The species)\b/;

/** The noun phrase a lead's first sentence opens with: "The quillback rockfish" from "The
 *  quillback rockfish (Sebastes maliger), also known as...", "Turbonilla acuta" from "Turbonilla
 *  acuta is a species of...". Null when there's no short, clear one. */
export function subjectOf(firstSentence: string): string | null {
  // Brackets go first: "The (American) five-lined skink (Plestiodon fasciatus) is...".
  const plain = firstSentence.replace(/\s*\([^()]*\)/g, "");
  const m = /^((?:The |An? )?[^(),;:.]+?)\s*(?:,| is | are | was | were )/.exec(plain);
  const subject = m?.[1].trim();
  if (!subject || /^(The|An?)$/.test(subject) || subject.length > 60 || subject.split(" ").length > 7) return null;
  return subject;
}

/** The sentence with a leading "It", "Its", "This species" or "The species" replaced by the
 *  subject, or null when it opens with another pronoun or there's no subject. */
export function nameTheSubject(sentence: string, subject: string | null): string | null {
  if (!subject) return null;
  const s = subject.replace(/^(The|An?) /, (_m, art: string) => `${art} `);
  const possessive = /s$/.test(s) ? `${s}'` : `${s}'s`;
  let m: RegExpExecArray | null;
  if ((m = /^Its\b/.exec(sentence))) return possessive + sentence.slice(m[0].length);
  if ((m = /^(It|This species|The species)\b/.exec(sentence))) return s + sentence.slice(m[0].length);
  return null;
}

const keepUseful = (_s: string, kind: SentenceKind) => !BOILERPLATE_KINDS.has(kind);

// Plain-text extracts keep list headings and items ("Variety", "Arion flagellus var. phillipsi
// Collinge, 1893 (unassessed)") as lines of their own; only real sentences count.
const isCompleteSentence = (s: string) => /[.!?]["'”’)\]]*$/.test(s);

// iNaturalist (and other sources) cut summaries mid-sentence and append "...".
function dropTruncatedTail(sentences: string[]): string[] {
  const last = sentences.at(-1);
  if (last && /(\.\.\.|…)$/.test(last)) return sentences.slice(0, -1);
  return sentences;
}

export interface DescriptionSources {
  /** The article's lead (plain text). */
  lead: string | null;
  /** The article's Description/Identification/Appearance section, when fetched. */
  identificationSection?: string | null;
  /** The lead was cut off by its source (iNaturalist), so a final "..." sentence is a fragment. */
  leadTruncated?: boolean;
}

/** Filters text to substantive content: at least 15 characters and a letter. */
export function isSubstantiveText(text: string): boolean {
  return text.length >= 15 && /\p{L}/u.test(text);
}

/** The species description from an article's lead and identification section, by the rule at the
 *  top of this file. Null when there's no substantive text at all. */
export function composeDescription(sources: DescriptionSources, maxChars = DESCRIPTION_MAX_CHARS): string | null {
  let leadAll = splitSentences(cleanExtractText(sources.lead ?? ""));
  if (sources.leadTruncated) leadAll = dropTruncatedTail(leadAll);
  leadAll = leadAll.filter(isCompleteSentence);
  const sectionAll = splitSentences(cleanExtractText(sources.identificationSection ?? "")).filter(isCompleteSentence);
  const lead = leadAll.filter((s) => keepUseful(s, classifySentence(s)));
  // The section is under an identification heading, so only boilerplate is dropped there too.
  const section = sectionAll.filter((s) => keepUseful(s, classifySentence(s)));

  let chosen: string[];
  if (section.length === 0) {
    chosen = takeWithinBudget(lead, maxChars);
  } else {
    const sectionWants = takeWithinBudget(section, Math.floor(maxChars / 2)).join(" ").length;
    const leadPart = takeWithinBudget(lead, maxChars - sectionWants - (sectionWants ? 1 : 0));
    const used = leadPart.join(" ").length;
    chosen = [...leadPart, ...takeWithinBudget(section, maxChars - used - (used ? 1 : 0))];
  }
  // A text can't open on "It is..." once the sentence that named the species was dropped. "It",
  // "Its" and "This species" become that sentence's subject ("The quillback rockfish"); any other
  // pronoun brings the sentence itself back, even when it's taxonomy, if it fits.
  const opener = leadAll[0];
  if (chosen.length > 0 && opener && chosen[0] !== opener && PRONOUN_START.test(chosen[0])) {
    const named = nameTheSubject(chosen[0], subjectOf(opener));
    if (named) {
      chosen = [named, ...chosen.slice(1)];
      // The subject can be longer than "It".
      while (chosen.length > 1 && chosen.join(" ").length > maxChars) chosen.pop();
    } else {
      const fitted = [opener, ...chosen];
      while (fitted.length > 1 && fitted.join(" ").length > maxChars) fitted.pop();
      if (fitted.length > 1) chosen = fitted;
    }
  }
  // A first kept sentence longer than the whole ceiling is still kept whole, alone.
  if (chosen.length === 0 && lead.length > 0) chosen = [lead[0]];
  if (chosen.length === 0 && section.length > 0) chosen = [section[0]];
  // A stub with nothing but boilerplate keeps its first sentence rather than nothing.
  if (chosen.length === 0) chosen = leadAll.slice(0, 1).length ? leadAll.slice(0, 1) : sectionAll.slice(0, 1);

  const text = chosen.join(" ").trim();
  return isSubstantiveText(text) ? text : null;
}

/** HTML (iNaturalist's wikipedia_summary) to plain text: tags removed, common entities decoded
 *  (a non-breaking space becomes a space rather than vanishing). */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
