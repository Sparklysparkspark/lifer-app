import { describe, expect, it } from "vitest";
import { renderPortfolio, type PortfolioContent } from "./render.js";

const content: PortfolioContent = {
  title: 'My <b>"birds"</b>',
  photos: [
    { photoId: "p1", width: 400, height: 300, commonName: "Heron <x>", scientificName: "Ardea herodias" },
    { photoId: "p2", width: null, height: null, commonName: null, scientificName: "Corvus corax" },
  ],
  lifeList: [
    { commonName: "Great Blue Heron", scientificName: "Ardea herodias", taxonClass: "Aves", year: 2021 },
    { commonName: null, scientificName: "Corvus corax", taxonClass: null, year: null },
  ],
};
const hrefs = {
  index: "index.html",
  lifeList: "life-list.html",
  photo: (id: string, k: string) => `photos/${id}-${k}.webp`,
};

describe("renderPortfolio", () => {
  const pages = renderPortfolio(content, hrefs);

  it("escapes names and the title", () => {
    expect(pages.index).not.toContain("<b>");
    expect(pages.index).toContain("Heron &lt;x&gt;");
    expect(pages.index).toContain("My &lt;b&gt;&quot;birds&quot;&lt;/b&gt;");
  });

  it("makes no outside request, runs no script and names no place", () => {
    for (const html of [pages.index, pages.lifeList!]) {
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).not.toMatch(/<script|<iframe|<link|@import|url\(/i);
      expect(html).not.toMatch(/\blat(itude)?\b|\blon(gitude)?\b|gps/i);
    }
  });

  it("links photos and the life list, and drops the list when left out", () => {
    expect(pages.index).toContain('src="photos/p1-thumb.webp"');
    expect(pages.index).toContain('href="life-list.html"');
    expect(pages.lifeList).toContain("Aves (1)");
    expect(pages.lifeList).toContain("Other (1)");
    const without = renderPortfolio({ ...content, lifeList: null }, hrefs);
    expect(without.lifeList).toBeNull();
    expect(without.index).not.toContain("life-list.html");
  });

  it("says so when there is nothing to show", () => {
    const empty = renderPortfolio({ title: "", photos: [], lifeList: [] }, hrefs);
    expect(empty.index).toContain("No photos yet.");
    expect(empty.lifeList).toContain("No species yet.");
  });
});
