import { describe, expect, it } from "vitest";
import { parse } from "@formatjs/icu-messageformat-parser";
import { IntlMessageFormat } from "intl-messageformat";
import { pseudoLocalize, pseudoLocalizeAll } from "./pseudo";

describe("pseudoLocalize", () => {
  it("accents, brackets and pads plain text", () => {
    const out = pseudoLocalize("Hidden photos");
    expect(out).toMatch(/^\[Ĥîððéñ þĥöţöš ~+\]$/);
    // About 40% of the 12 letters.
    expect(out.match(/~/g)).toHaveLength(5);
  });

  it("leaves placeholders, plural and select syntax intact and still valid ICU", () => {
    const message = "{count, plural, one {# photo} other {# photos}} in {album}";
    const out = pseudoLocalize(message);
    expect(() => parse(out)).not.toThrow();
    const formatted = new IntlMessageFormat(out, "en").format({ count: 3, album: "Kenya" });
    expect(formatted).toMatch(/^\[3 þĥöţöš îñ Kenya ~+\]$/);
    expect(new IntlMessageFormat(pseudoLocalize("{kind, select, video {Video} other {Photo}}"), "en").format({ kind: "video" })).toMatch(
      /^\[Ṽîðéö ~+\]$/,
    );
  });

  it("keeps tags for <Trans>, accenting only their text", () => {
    expect(pseudoLocalize("Open <link>the guide</link>")).toMatch(/^\[Öþéñ <link>ţĥé ĝûîðé<\/link> ~+\]$/);
  });

  it("keeps self-closing <Trans> slots", () => {
    expect(pseudoLocalize("Added <name/> to the trip")).toMatch(/^\[Åððéð <name\/> ţö ţĥé ţŕîþ ~+\]$/);
  });

  it("keeps escaped apostrophes escaped", () => {
    const out = pseudoLocalize("Couldn't load ''{name}''");
    expect(new IntlMessageFormat(out, "en").format({ name: "x" })).toMatch(/^\[Çöûļðñ'ţ ļöáð 'x' ~+\]$/);
  });

  it("returns a message that isn't valid ICU unchanged", () => {
    expect(pseudoLocalize("{broken")).toBe("{broken");
  });

  it("transforms a whole nested resource tree", () => {
    expect(pseudoLocalizeAll({ a: { b: "Hi" } })).toEqual({ a: { b: "[Ĥî ~~]" } });
  });
});
