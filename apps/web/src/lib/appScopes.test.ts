import { describe, expect, it } from "vitest";
import i18n from "i18next";
import { appScopeDetail, appScopeLabel, keyScopeLabel } from "./appScopes";

const t = i18n.t.bind(i18n) as unknown as Parameters<typeof appScopeLabel>[0];

describe("appScopes", () => {
  it("words a connected app's scope once, for pairing and for review", () => {
    expect(appScopeLabel(t, "imports.write")).toBe("Import photos into your library");
    expect(appScopeDetail(t, "imports.write")).toBeNull();
    expect(appScopeDetail(t, "userdata.write")).toMatch(/^Rate your photos/);
    expect(appScopeLabel(t, "made.up")).toBe("made.up");
  });

  it("labels API key permissions by resource and access", () => {
    expect(keyScopeLabel(t, "album.write")).toBe("Albums: Write");
    expect(keyScopeLabel(t, "collection.read")).toBe("Life list: Read");
    expect(keyScopeLabel(t, "made.up")).toBe("made.up");
  });
});
