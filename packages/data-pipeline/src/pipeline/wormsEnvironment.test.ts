// WoRMS habitat parsing and the freshwater-only rule.
import { describe, expect, it } from "vitest";
import { environmentFromRecords, fetchEnvironments, isFreshwaterOrLandOnly, namesUrl } from "./wormsEnvironment.js";

describe("environmentFromRecords", () => {
  it("prefers the accepted species record and reads the 0/1 flags", () => {
    const env = environmentFromRecords([
      { AphiaID: 1, status: "unaccepted", isMarine: 0, isFreshwater: 1 },
      {
        AphiaID: 2,
        valid_AphiaID: 2,
        status: "accepted",
        rank: "Species",
        isMarine: 1,
        isBrackish: 0,
        isFreshwater: 0,
        isTerrestrial: null,
      },
    ]);
    expect(env).toEqual({ aphiaId: 2, marine: true, brackish: false, freshwater: false, terrestrial: null });
  });

  it("gives null when WoRMS has no match", () => {
    expect(environmentFromRecords(null)).toBeNull();
    expect(environmentFromRecords([])).toBeNull();
  });
});

describe("isFreshwaterOrLandOnly", () => {
  it("is true only when the species is never marine or brackish", () => {
    expect(isFreshwaterOrLandOnly({ marine: false, brackish: false, freshwater: true, terrestrial: false })).toBe(true);
    // A pike recorded in brackish water (the Baltic) stays eligible for a sea zone.
    expect(isFreshwaterOrLandOnly({ marine: false, brackish: true, freshwater: true, terrestrial: false })).toBe(false);
    expect(isFreshwaterOrLandOnly({ marine: true, brackish: null, freshwater: true, terrestrial: null })).toBe(false);
  });

  it("never treats unknown habitats as freshwater-only", () => {
    expect(isFreshwaterOrLandOnly({ marine: null, brackish: null, freshwater: true, terrestrial: null })).toBe(false);
    expect(isFreshwaterOrLandOnly({ marine: false, brackish: false, freshwater: null, terrestrial: null })).toBe(false);
  });
});

describe("fetchEnvironments", () => {
  it("asks for every name and aligns the answers with them", async () => {
    let url = "";
    const fake = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify([[{ AphiaID: 7, status: "accepted", isMarine: 1 }], null]), { status: 200 });
    }) as unknown as typeof fetch;
    const envs = await fetchEnvironments(["Cetorhinus maximus", "Nobody here"], fake);
    expect(url).toBe(namesUrl(["Cetorhinus maximus", "Nobody here"]));
    expect(url).toContain("scientificnames[]=Cetorhinus%20maximus");
    expect(envs[0]?.marine).toBe(true);
    expect(envs[1]).toBeNull();
  });

  it("treats 204 as no matches and throws on a refusal", async () => {
    const noContent = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await fetchEnvironments(["A b"], noContent)).toEqual([null]);
    const limited = (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
    await expect(fetchEnvironments(["A b"], limited)).rejects.toMatchObject({ status: 429 });
  });
});
