// Which interface language to show, and which locale dates and numbers follow. Pure functions,
// so the rules are unit tested without a browser (see resolveLocale.test.ts).

/** The language the interface is written in, and the fallback for every missing string. */
export const SOURCE_LOCALE = "en";

/** A generated test locale (accented, padded English) for checking layout with longer text. */
export const PSEUDO_LOCALE = "en-XA";

/** What the user picked in Settings > General: "auto" follows the system, or a locale code. */
export type LocalePreference = "auto" | (string & {});

// System languages that should land on a locale with a different code.
const ALIASES: Record<string, string> = {
  no: "nb", // "Norwegian" without a variant reads as Bokmål
};

// Language and script of a tag, so zh-CN matches zh-Hans and pt-BR matches pt.
function languageAndScript(tag: string): { language: string; script: string } | null {
  try {
    const locale = new Intl.Locale(tag).maximize();
    const language = ALIASES[locale.language] ?? locale.language;
    return { language, script: locale.script ?? "" };
  } catch {
    return null;
  }
}

/**
 * The interface locale for a preference: the chosen locale when it's available, otherwise the
 * first system language that has a locale (exact code first, then same language and script),
 * otherwise English.
 */
export function resolveLocale(
  preference: LocalePreference | null | undefined,
  systemLanguages: readonly string[],
  available: readonly string[],
): string {
  if (preference && preference !== "auto" && available.includes(preference)) return preference;
  const lowerAvailable = available.map((code) => code.toLowerCase());
  for (const system of systemLanguages) {
    const exact = lowerAvailable.indexOf(system.toLowerCase());
    if (exact !== -1) return available[exact];
    const wanted = languageAndScript(system);
    if (!wanted) continue;
    const match = available.find((code) => {
      if (code === PSEUDO_LOCALE) return false;
      const candidate = languageAndScript(code);
      return candidate?.language === wanted.language && candidate.script === wanted.script;
    });
    if (match) return match;
  }
  return SOURCE_LOCALE;
}

/**
 * The locale dates and numbers are formatted in. A system language with a region (en-GB) is kept
 * when it's a variant of the interface language, so British English users keep day-first dates;
 * otherwise the interface locale itself. The pseudo-locale formats like English.
 */
export function formattingLocale(uiLocale: string, systemLanguages: readonly string[]): string {
  const target = languageAndScript(uiLocale === PSEUDO_LOCALE ? SOURCE_LOCALE : uiLocale);
  for (const system of systemLanguages) {
    const candidate = languageAndScript(system);
    if (candidate && target && candidate.language === target.language && candidate.script === target.script) {
      return system;
    }
  }
  return uiLocale === PSEUDO_LOCALE ? SOURCE_LOCALE : uiLocale;
}

// Right-to-left scripts' languages, for runtimes without Intl.Locale text info.
const RTL_LANGUAGES = new Set(["ar", "arc", "ckb", "dv", "fa", "ha", "he", "khw", "ks", "ps", "sd", "ug", "ur", "yi"]);

/** "rtl" or "ltr" for a locale, for the html dir attribute. */
export function textDirection(tag: string): "ltr" | "rtl" {
  try {
    const locale = new Intl.Locale(tag) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    const direction = locale.getTextInfo?.().direction ?? locale.textInfo?.direction;
    if (direction === "rtl" || direction === "ltr") return direction;
    return RTL_LANGUAGES.has(locale.language) ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

/** A locale's name in its own language ("Deutsch", "日本語"), for the language picker. */
export function nativeLanguageName(tag: string): string {
  if (tag === PSEUDO_LOCALE) return "Ƥšéûðö Éñĝļîšĥ (en-XA)";
  try {
    const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
    if (!name) return tag;
    // Language names are lower case in some languages ("español"); a picker lists them capitalised.
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}
