import { describe, expect, it } from "vitest";
import { formattingLocale, nativeLanguageName, resolveLocale, textDirection } from "./resolveLocale";

const ALL = ["en", "es", "de", "fr", "pt", "it", "nl", "pl", "sv", "fi", "da", "cs", "ja", "zh-Hans", "ko", "nb", "ru"];

describe("resolveLocale", () => {
  it("uses a chosen locale that is available", () => {
    expect(resolveLocale("de", ["fr-FR"], ALL)).toBe("de");
    expect(resolveLocale("zh-Hans", [], ALL)).toBe("zh-Hans");
  });

  it("follows the system when automatic, or when the chosen locale isn't available", () => {
    expect(resolveLocale("auto", ["fr-FR", "en-US"], ALL)).toBe("fr");
    expect(resolveLocale(null, ["sv"], ALL)).toBe("sv");
    expect(resolveLocale("tlh", ["it-IT"], ALL)).toBe("it");
  });

  it("matches region variants by language, and Chinese by script", () => {
    expect(resolveLocale("auto", ["pt-BR"], ALL)).toBe("pt");
    expect(resolveLocale("auto", ["zh-CN"], ALL)).toBe("zh-Hans");
    expect(resolveLocale("auto", ["zh-SG"], ALL)).toBe("zh-Hans");
    // Traditional Chinese isn't Simplified: fall through to the next system language.
    expect(resolveLocale("auto", ["zh-TW", "ja-JP"], ALL)).toBe("ja");
  });

  it("reads plain Norwegian as Bokmål", () => {
    expect(resolveLocale("auto", ["no"], ALL)).toBe("nb");
    expect(resolveLocale("auto", ["nb-NO"], ALL)).toBe("nb");
  });

  it("matches exact codes case-insensitively, before language matches", () => {
    expect(resolveLocale("auto", ["ZH-hans"], ALL)).toBe("zh-Hans");
  });

  it("falls back to English", () => {
    expect(resolveLocale("auto", ["tlh", "xx-YY"], ALL)).toBe("en");
    expect(resolveLocale("auto", [], ["en"])).toBe("en");
    expect(resolveLocale("auto", ["de-DE"], ["en"])).toBe("en");
  });

  it("only picks the pseudo-locale when chosen", () => {
    expect(resolveLocale("en-XA", [], ["en", "en-XA"])).toBe("en-XA");
    expect(resolveLocale("auto", ["en-US"], ["en", "en-XA"])).toBe("en");
    expect(resolveLocale("en-XA", [], ["en"])).toBe("en");
  });
});

describe("formattingLocale", () => {
  it("keeps the system's regional variant of the interface language", () => {
    expect(formattingLocale("en", ["en-GB"])).toBe("en-GB");
    expect(formattingLocale("de", ["en-US", "de-AT"])).toBe("de-AT");
  });

  it("uses the interface locale when the system has no variant of it", () => {
    expect(formattingLocale("de", ["en-US"])).toBe("de");
    expect(formattingLocale("zh-Hans", ["zh-TW"])).toBe("zh-Hans");
  });

  it("formats the pseudo-locale like English", () => {
    expect(formattingLocale("en-XA", [])).toBe("en");
    expect(formattingLocale("en-XA", ["en-AU"])).toBe("en-AU");
  });
});

describe("textDirection", () => {
  it("is left to right for every planned locale", () => {
    for (const code of ALL) expect(textDirection(code)).toBe("ltr");
  });

  it("is right to left for RTL scripts", () => {
    expect(textDirection("ar")).toBe("rtl");
    expect(textDirection("he-IL")).toBe("rtl");
    expect(textDirection("fa")).toBe("rtl");
  });

  it("treats a malformed tag as left to right", () => {
    expect(textDirection("not a tag")).toBe("ltr");
  });
});

describe("nativeLanguageName", () => {
  it("names each language in itself, capitalised", () => {
    expect(nativeLanguageName("de")).toBe("Deutsch");
    expect(nativeLanguageName("es")).toBe("Español");
    expect(nativeLanguageName("ja")).toBe("日本語");
    expect(nativeLanguageName("en")).toBe("English");
  });

  it("labels the pseudo-locale", () => {
    expect(nativeLanguageName("en-XA")).toContain("en-XA");
  });
});
