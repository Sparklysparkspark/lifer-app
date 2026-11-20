// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "i18next";
import { I18nextProvider, initReactI18next, Trans } from "react-i18next";
import en from "../locales/en.json";

describe("Trans link tags", () => {
  it("renders the link with its words inside, for every <a> string in en.json", async () => {
    const instance = i18n.createInstance();
    await instance
      .use(initReactI18next)
      .init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
    const keys: string[] = [];
    const walk = (o: Record<string, unknown>, p: string) =>
      Object.entries(o).forEach(([k, v]) =>
        typeof v === "string"
          ? v.includes("<a>") && keys.push(`${p}${k}`)
          : walk(v as Record<string, unknown>, `${p}${k}.`),
      );
    walk(en, "");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const { unmount } = render(
        <I18nextProvider i18n={instance}>
          <Trans
            i18nKey={key}
            values={{ count: 2, region: "R", taxon: "T", username: "u" }}
            components={{ a: <a href="/x" /> }}
          />
        </I18nextProvider>,
      );
      const link = document.querySelector("a");
      expect(link?.textContent, key).toBeTruthy();
      unmount();
    }
  });
});
