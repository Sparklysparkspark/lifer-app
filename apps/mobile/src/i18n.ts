import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";

// Hermes on iPhone has no Intl.PluralRules, which ICU plurals need. English only for now: one or other.
// A language with more plural forms brings the real polyfill (@formatjs/intl-pluralrules) instead.
if (typeof Intl.PluralRules !== "function") {
  (Intl as unknown as { PluralRules: unknown }).PluralRules = class {
    select = (n: number) => (n === 1 ? "one" : "other");
    resolvedOptions = () => ({ locale: "en" });
    static supportedLocalesOf = (l: string[]) => l;
  };
}

// English only for now; the locale list grows with translations.
void i18next
  .use(new ICU())
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });

export default i18next;
