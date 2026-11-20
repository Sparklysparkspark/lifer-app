import { describe, expect, it } from "vitest";
import { priceKeyFor } from "./cullPrice";

describe("priceKeyFor", () => {
  it.each([
    ["en-GB", "gbp"],
    ["de-DE", "eur"],
    ["fr-FR", "eur"],
    ["en-IE", "eur"],
    ["nl-NL", "eur"],
    ["sv-SE", "usd"],
    ["pl-PL", "usd"],
    ["en-US", "usd"],
    ["en", "usd"],
    ["", "usd"],
    [undefined, "usd"],
    ["not a locale!", "usd"],
  ])("%s -> %s", (locale, key) => expect(priceKeyFor(locale)).toBe(key));
});
