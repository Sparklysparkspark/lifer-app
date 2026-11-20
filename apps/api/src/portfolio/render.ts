// The portfolio's pages as plain HTML strings. No scripts and no address outside the site itself,
// and no place or coordinate is ever written: a portfolio shows what was seen, never where.
export interface PortfolioPhoto {
  photoId: string;
  width: number | null;
  height: number | null;
  commonName: string | null;
  scientificName: string;
}

export interface LifeListEntry {
  commonName: string | null;
  scientificName: string;
  taxonClass: string | null;
  year: number | null;
}

export interface PortfolioContent {
  title: string;
  photos: PortfolioPhoto[];
  /** Null when the life list is left out. */
  lifeList: LifeListEntry[] | null;
}

export interface PortfolioHrefs {
  index: string;
  lifeList: string;
  photo: (photoId: string, kind: "display" | "thumb") => string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `:root{color-scheme:light dark;--bg:#fafaf9;--ink:#1c1917;--muted:#78716c;--line:#e7e5e4}
@media(prefers-color-scheme:dark){:root{--bg:#1c1917;--ink:#fafaf9;--muted:#a8a29e;--line:#44403c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
header,main{max-width:72rem;margin:0 auto;padding:1rem}
nav{display:flex;gap:1rem;color:var(--muted)}a{color:inherit}
h1{font-size:1.5rem;margin:.5rem 0}h2{font-size:1.125rem;margin:1.5rem 0 .5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(16rem,100%),1fr));gap:.75rem;margin:0;padding:0;list-style:none}
.grid figure{margin:0}.grid img{display:block;width:100%;height:auto;border-radius:.5rem;background:var(--line)}
figcaption{font-size:.875rem;color:var(--muted);overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse}td,th{padding:.4rem .5rem;border-bottom:1px solid var(--line);text-align:left;overflow-wrap:anywhere}
.sci{font-style:italic;color:var(--muted)}`;

function page(content: PortfolioContent, hrefs: PortfolioHrefs, current: "photos" | "lifeList", body: string): string {
  const title = escapeHtml(content.title || "Portfolio");
  const link = (key: "photos" | "lifeList", href: string, label: string) =>
    key === current ? `<span aria-current="page">${label}</span>` : `<a href="${escapeHtml(href)}">${label}</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${STYLE}</style></head>
<body><header><h1>${title}</h1>${
    content.lifeList
      ? `<nav>${link("photos", hrefs.index, "Photos")}${link("lifeList", hrefs.lifeList, "Life list")}</nav>`
      : ""
  }</header><main>${body}</main></body></html>
`;
}

function photosBody(content: PortfolioContent, hrefs: PortfolioHrefs): string {
  if (content.photos.length === 0) return `<p>No photos yet.</p>`;
  const items = content.photos.map((p) => {
    const name = escapeHtml(p.commonName ?? p.scientificName);
    const size = p.width && p.height ? ` width="${p.width}" height="${p.height}"` : "";
    return `<li><figure><a href="${escapeHtml(hrefs.photo(p.photoId, "display"))}"><img src="${escapeHtml(
      hrefs.photo(p.photoId, "thumb"),
    )}" alt="${name}" loading="lazy"${size}></a><figcaption>${name}</figcaption></figure></li>`;
  });
  return `<ul class="grid">${items.join("")}</ul>`;
}

function lifeListBody(entries: LifeListEntry[]): string {
  if (entries.length === 0) return `<p>No species yet.</p>`;
  const byClass = new Map<string, LifeListEntry[]>();
  for (const e of entries) {
    const key = e.taxonClass ?? "Other";
    byClass.set(key, [...(byClass.get(key) ?? []), e]);
  }
  return [...byClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, rows]) => {
      const lines = rows
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.commonName ?? e.scientificName)}${
              e.commonName ? ` <span class="sci">${escapeHtml(e.scientificName)}</span>` : ""
            }</td><td>${e.year ?? ""}</td></tr>`,
        )
        .join("");
      return `<h2>${escapeHtml(cls)} (${rows.length})</h2><table><thead><tr><th>Species</th><th>First photographed</th></tr></thead><tbody>${lines}</tbody></table>`;
    })
    .join("");
}

export function renderPortfolio(
  content: PortfolioContent,
  hrefs: PortfolioHrefs,
): { index: string; lifeList: string | null } {
  return {
    index: page(content, hrefs, "photos", photosBody(content, hrefs)),
    lifeList: content.lifeList ? page(content, hrefs, "lifeList", lifeListBody(content.lifeList)) : null,
  };
}
