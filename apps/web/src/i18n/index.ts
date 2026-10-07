// The interface's translations: i18next with ICU messages (i18next-icu), so plurals, selects and
// placeholders are standard ICU MessageFormat, which Weblate checks and translators know.
//
// English (locales/en.json) is bundled and initialised synchronously, so the first render, unit
// tests and helpers outside React (i18n.t) work at once. Every other locale is its own chunk,
// loaded by dynamic import when chosen, so the bundle doesn't grow per language. The pseudo-locale
// en-XA is generated from English, and only offered in development or with VITE_PSEUDO_LOCALE=1.
//
// See docs/docs/contributing/translating.md.
import i18n from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import { setFormatLocale } from "../lib/format";
import {
  formattingLocale,
  PSEUDO_LOCALE,
  resolveLocale,
  SOURCE_LOCALE,
  textDirection,
  type LocalePreference,
} from "./resolveLocale";

export { PSEUDO_LOCALE, SOURCE_LOCALE, type LocalePreference } from "./resolveLocale";

type Messages = { [key: string]: string | Messages };

// One chunk per translated locale. en.json is left out: it's bundled above.
const localeLoaders = import.meta.glob<Messages>(["../locales/*.json", "!../locales/en.json"], {
  import: "default",
});
const loaderByLocale = new Map(
  Object.entries(localeLoaders).map(([path, load]) => [path.replace(/^.*\/([^/]+)\.json$/, "$1"), load]),
);

/** The pseudo-locale is a developer tool: shown in dev builds or when built with VITE_PSEUDO_LOCALE=1. */
export const PSEUDO_LOCALE_ENABLED = import.meta.env.DEV || import.meta.env.VITE_PSEUDO_LOCALE === "1";

/** Locales the language picker offers: English, every locales/*.json, and en-XA when enabled. */
export const AVAILABLE_LOCALES: readonly string[] = [
  SOURCE_LOCALE,
  ...[...loaderByLocale.keys()].sort(),
  ...(PSEUDO_LOCALE_ENABLED ? [PSEUDO_LOCALE] : []),
];

void i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    lng: SOURCE_LOCALE,
    fallbackLng: SOURCE_LOCALE,
    resources: { [SOURCE_LOCALE]: { translation: en } },
    partialBundledLanguages: true,
    initAsync: false,
    // React escapes what it renders; escaping here too would show &amp; in the page.
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  });

async function ensureLoaded(locale: string): Promise<void> {
  if (i18n.hasResourceBundle(locale, "translation")) return;
  if (locale === PSEUDO_LOCALE) {
    const { pseudoLocalizeAll } = await import("./pseudo");
    i18n.addResourceBundle(locale, "translation", pseudoLocalizeAll(en), true, true);
    return;
  }
  const load = loaderByLocale.get(locale);
  if (load) i18n.addResourceBundle(locale, "translation", await load(), true, true);
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/** Switches the interface to a preference ("auto" or a locale code): loads its messages, then
 *  updates i18next, the html lang and dir attributes, and the locale dates and numbers use. */
export async function applyLocalePreference(preference: LocalePreference | null | undefined): Promise<string> {
  const system = systemLanguages();
  let locale = resolveLocale(preference, system, AVAILABLE_LOCALES);
  try {
    await ensureLoaded(locale);
  } catch {
    // A chunk that fails to load (offline, a deploy in between) leaves the interface in English.
    locale = SOURCE_LOCALE;
  }
  setFormatLocale(formattingLocale(locale, system));
  if (i18n.language !== locale) await i18n.changeLanguage(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = textDirection(locale);
  }
  return locale;
}

// The preference is kept in localStorage too, so the right language shows from the first paint,
// before GET /settings answers (and on the sign-in page, where there is no account yet).
const PREFERENCE_KEY = "lifer.locale";

export function readCachedLocalePreference(): LocalePreference {
  try {
    return localStorage.getItem(PREFERENCE_KEY) || "auto";
  } catch {
    return "auto";
  }
}

export function cacheLocalePreference(preference: LocalePreference): void {
  try {
    localStorage.setItem(PREFERENCE_KEY, preference);
  } catch {
    // Storage blocked: the account setting still applies once settings load.
  }
}

export default i18n;
