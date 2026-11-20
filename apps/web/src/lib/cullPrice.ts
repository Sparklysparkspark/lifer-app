// One price, in the person's own currency, from the region of their locale (no network, no IP lookup).
const EURO = new Set("AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" "));

export type PriceKey = "gbp" | "eur" | "usd";

export function priceKeyFor(locale: string | undefined): PriceKey {
  let region: string | undefined;
  try {
    region = locale ? new Intl.Locale(locale).region : undefined;
  } catch {
    // An unparseable locale is the same as a missing region.
  }
  if (region === "GB") return "gbp";
  return region && EURO.has(region) ? "eur" : "usd";
}
