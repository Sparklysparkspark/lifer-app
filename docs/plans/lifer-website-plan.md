# Lifer website

> **Calibration (2026-10-22):** effort figures in this plan are conventional engineering time. Lifer's
> measured pace is far faster for coding: about 176,000 lines (desktop, server, web, species matching
> and a 134,000-species catalogue) in roughly six effective weeks. Expect coding work to take a fraction
> of these estimates. Real-world time does not compress: maintainer reviews and decisions, beta periods,
> store review, real-device and real-card testing, and model labelling.

Status: planned, nothing built. Drafted 2026-10-22. Planning only: nothing is bought, committed,
branched or deployed by this plan. Every choice marked NEEDS MAINTAINER APPROVAL waits for the
maintainer.

Models: each work package names who builds it (Opus 5.5 for architecture, security and the domain
cut-over; Sonnet 5.5 for pages and components; Haiku 5.5 for chores), and every package gets an
Opus 5.5 review before hand-back. Helpers read only their own package, the sections it links to, the
standing rules and the briefing.

## Why

Lifer's only public face today is the docs site at `sparklysparkspark.github.io/lifer-app`. Before the
public beta and 1.0, Lifer needs a proper home under its own name, **Lifer Wildlife Archive**, that:

- says in one screen what Lifer is and shows it with real screenshots,
- gets people to the right download (Mac, Windows, Linux) or the self-hosting guide (Docker, TrueNAS),
- keeps the docs, GitHub, the AGPL licence and the privacy page one click away,
- moves every existing docs link to the new domain without breaking any of them,
- moves the iNaturalist sign-in relay page to the final domain before the iNaturalist app
  registration is finalised, since the registration names that redirect URI.

Out of scope: accounts, comments, a forum (GitHub Discussions stays), a blog (GitHub Releases and the
changelog stay), a newsletter, any form that collects personal data.

## Principles

1. **Lifer itself never contacts us.** The website is a website. Nothing in the app reports to it.
   Links from the app to the site are plain URLs with no tags or identifiers.
2. **Cookie-free counting only.** One privacy-friendly, cookie-free analytics script (Plausible) on the
   website. No other third-party script, font, embed or pixel. No cookie banner, because there are no
   cookies.
3. **Plain, honest copy.** Say what Lifer does today. No "coming soon" tags that go stale, no invented
   numbers, no dark patterns.
4. **Docs stay where they are, in the repo.** The site is built from `lifer-app/docs/`, so a code
   change and its docs change land together.
5. **Every link keeps working.** Old URLs redirect to the same page on the new domain.
6. **Same look as the app.** The site's tokens come from the app's `apps/web/src/theme.css`.
7. **Accessible and fast by default.** WCAG 2.2 AA, light and dark, small screens, very long text.

## Decisions (NEEDS MAINTAINER APPROVAL)

| # | Decision | Recommendation | Why | Alternative |
|---|---|---|---|---|
| D1 | Framework | **Keep Docusaurus** and add the marketing pages to it as custom pages (`docs/src/pages/`) | The docs already build, search, check broken links and anchors (`onBrokenLinks: "throw"`) and follow the app's colours. Adding about five pages costs far less than migrating 60+ docs pages, and keeps one build and one deploy. React components match the app's skills. | Astro (Starlight for docs): lighter pages by default, but a full docs migration, a new search, a new link checker and new CI. Worth it only if the performance budgets below can't be met. |
| D2 | Repo | **Inside `lifer-app`, in the existing `docs/` folder** | Docs and code change together; the iNaturalist relay page's test already reads `docs/static/inat-callback/index.html`; the docs workflow exists. | Its own public repo: cleaner history, but docs drift from code and the relay test must change. |
| D3 | Domain | **`liferwildlife.com` as the one canonical domain; `liferwildlife.app` redirects to it** | `.com` is what people type; `.app` is cheap insurance. Chosen 2026-10-25, when the .com was unregistered; check the .app before buying. | `.app` canonical. |
| D4 | Hosting and CDN | **GitHub Pages with a custom domain** (GitHub's CDN, free, HTTPS by Let's Encrypt). DNS at Cloudflare (free), DNS-only records for the Pages site. | No new host. When a GitHub Pages project site gets a custom domain, GitHub redirects the old `github.io/lifer-app/...` URLs to the same path on the custom domain, which handles most of the link move by itself (verified in LW-10 before relying on it). | Cloudflare Pages: real `_redirects` and `_headers` files, but then the old `github.io` URLs need a separate stub site. |
| D5 | Docs URLs | **Docs keep their exact paths at the domain root** (`/install/desktop`, `/guides/...`, `/api/overview`). Only the intro page moves from `/` to `/intro`, because `/` becomes the home page. | Combined with D4, every old link lands on the same page. | Docs under `/docs/...`: tidier, but every old link needs a redirect stub. |
| D6 | Analytics | **Plausible** (cookie-free, EU-hosted, open source, no personal data), the script only on the website | Fits a privacy page that says "no tracking"; one honest line explains it. | Cloudflare Web Analytics (free, cookie-free, US-hosted); GoatCounter (open source, cookie-free); none at all. |
| D7 | Forms | **None on Lifer's site** | Nothing to collect. Feedback goes to GitHub Discussions and Issues. | A release-notes email list (see open question 6). |
| D8 | Legal pages | **Privacy (extend the existing page), licence (AGPL-3.0 page linking the full text), credits (existing), security policy (GitHub).** No terms of service: Lifer is free software under the AGPL, there is no service. | Matches what exists; nothing invented. | A short "terms of use" for the website only; not needed without accounts or forms. |
| D9 | Shared design kit | **`docs/src/site-kit/`**: tokens, type and a few components, under the **MIT licence** (its own `LICENSE` file), so other projects (including plugin makers) can reuse the look | One place for the site's look, kept in step with the app's tokens by a test. | Inline in `custom.css` (no reuse). |
| D10 | Light and dark | **Follow the system, with the existing toggle**; the choice is kept in local storage (no cookie) | Same as the app. | Light only. |

## Site map

| Path | Page | New or existing |
|---|---|---|
| `/` | Home: what Lifer is, screenshots, the main features, download and self-host buttons, "Works with" | New |
| `/download` | Mac (Apple silicon, Intel), Windows, Linux (AppImage, deb), checksums, requirements, what the first launch looks like | New (navbar "Download" stops linking straight to GitHub) |
| `/self-hosting` | Desktop or server, Docker quick start, TrueNAS, reverse proxy, backups, links into `/install/*` | New |
| `/open-source` | AGPL-3.0 in plain words, GitHub, contributing, code of conduct, credits, security | New |
| `/intro` | The docs introduction (was `/`) | Moved |
| `/install/*`, `/guides/*`, `/api/*`, `/contributing/*`, `/settings`, `/faq`, `/troubleshooting`, `/support`, `/roadmap`, `/credits`, `/security-model`, `/code-signing` | Docs | Unchanged paths |
| `/privacy` | Privacy, with a new "This website" section | Existing, extended |
| `/inat-callback/` | iNaturalist sign-in relay (static, `noindex`, `no-referrer`) | Existing, same file |

The home page's features (from what Lifer does today and the library-first plan): point Lifer at your
photo folders and it finds the species; a life list built from your own photos, with seen and
photographed kept apart; targets and "still need a photo"; regional checklists and offline maps;
search across the whole archive; trips, albums and sharing; stats and your year in wildlife;
iNaturalist and eBird; desktop app or your own server, with your phone using the server in its
browser. Only features that ship in the release being promoted appear.

**"Works with" section:** the integrations (iNaturalist, eBird, Lightroom Classic, Immich) plus an
optional partner apps section, content provided separately. It renders from a data file,
`docs/src/data/partnerApps.json`, which is `[]` in the repo; an empty file hides the sub-section
entirely.

## How it fits together

```
liferwildlife.app ---301---> liferwildlife.com  (Cloudflare redirect rule)

liferwildlife.com  (GitHub Pages, custom domain, built by .github/workflows/docs.yml)
  /                 home, /download, /self-hosting, /open-source   (docs/src/pages/)
  /intro, /install/*, /guides/*, ...                               (docs/docs/)
  /inat-callback/                                                  (docs/static/)

sparklysparkspark.github.io/lifer-app/<path>  ---GitHub redirect--->  liferwildlife.com/<path>

Downloads: GitHub Releases (unchanged). The download page reads the latest release at build time.
Analytics: plausible.io script, website only.
```

## Shared design kit

- **Tokens** (`site-kit/tokens.css`): the app's colour tokens (`--color-canvas`, `surface`, `ink`,
  `muted`, `accent`, `link`, `line`, light and dark), radii (`panel`, `control`, `badge`), spacing
  (`page`, `section`, `item`, `panel`) and the named text styles, plus a mapping onto Docusaurus's
  `--ifm-*` variables. Display sizes for marketing headings are added on top of the app's scale.
- **Type:** the app's system font stack. No web fonts, so no font requests.
- **Components** (React, used by the custom pages): `Hero`, `Section`, `FeatureRow` (screenshot and
  text), `ScreenshotFrame` (light and dark pair, `srcset`), `DownloadCard`, `PlatformPicker`,
  `Callout`, `CardGrid`, `PartnerCard`, `ButtonLink` (primary and secondary only).
- **Theming hook:** a page or site can override the accent tokens in one place; the components never
  hard-code colours.
- **Check:** a unit test reads `apps/web/src/theme.css` and fails if a shared token's value differs in
  `site-kit/tokens.css`; a contrast test (the app's `contrast.test.ts` approach) checks every text and
  background pair in both modes at 4.5:1 (3:1 for large text and UI edges).

## Quality bars

- **Accessibility:** WCAG 2.2 AA. axe-core over every page in the sitemap, light and dark, desktop
  and 360 px wide; keyboard-only walk of the home and download pages; visible focus; skip link; one
  `h1` per page; alt text on every screenshot; reflow at 320 px and 400% zoom; `prefers-reduced-motion`
  respected; captions on any video.
- **Performance budgets** (Lighthouse mobile, simulated slow 4G, per marketing page): LCP under 2.5 s,
  CLS under 0.05, TBT under 200 ms, JavaScript under 200 KB gzipped, images above the fold under
  400 KB, total page weight under 1 MB. Screenshots in AVIF or WebP with a PNG fallback, sized with
  `srcset`, width and height set. Lighthouse performance 90 or more, accessibility 100.
- **SEO and Open Graph:** a title and description on every page, canonical URLs on the new domain,
  sitemap and robots (the relay page stays `noindex`), `SoftwareApplication` JSON-LD on home and
  download (free, three platforms), one Open Graph card per top-level page (1200 x 630) in the site's
  look, light background, legible at thumbnail size. The name is always "Lifer Wildlife Archive" in
  titles, since other birding apps use "Lifer".
- **Privacy:** the only third-party request any page makes is Plausible; a test asserts it.
- **Extremes:** 360 px phones, 4K screens, 200% text, dark mode, a 60-character feature title, a
  release with 12 assets, no JavaScript (every page reads, every download link works).

## Work packages

Each package is sized for one worker session. Standing rules (below) apply to all of them.

### LW-01 Site structure and URL plan

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the Docusaurus site gains a home page at `/` and room for the new pages, with every
  existing docs path unchanged.
- **Scope in:** intro slug `/` to `/intro`; empty stub pages for `/`, `/download`, `/self-hosting`,
  `/open-source`; navbar (Docs, Download, Self-hosting, API, GitHub) and footer (adds Privacy, Open
  source); `url` and `baseUrl` from `DOCS_URL` and `DOCS_BASE_URL` defaulting to the new domain once
  LW-10 lands; a `URLS.md`-style table in this plan's appendix of every route before and after. **Out:**
  page content, styling.
- **Files:** `docs/docusaurus.config.ts`, `docs/sidebars.ts`, `docs/docs/intro.md` (front matter only),
  `docs/src/pages/{index,download,self-hosting,open-source}.tsx` (new stubs).
- **Depends on:** D1, D2, D5 approved.
- **Steps:** change the intro slug; add the stubs; update every internal link to `/` that meant the
  intro (the broken-link check finds them); generate the route list from the build's `sitemap.xml`
  before and after and diff it.
- **Tests:** `npm run build` in `docs/` (broken links and anchors throw); the route diff shows only
  `/` changed meaning and four routes added.
- **Acceptance:** every pre-change route still builds at the same path; the intro is at `/intro`; the
  navbar works on a 360 px screen.
- **UX checks:** W1, W5, W8 on nav labels; HIG check of the navbar at 360 px and 1440 px, light and
  dark.
- **Risks:** pages elsewhere linking to the docs root expecting the intro; the in-app `docsUrl("/")`
  callers (grep `docsUrl(` in `apps/web/src`) should point to `/intro` where they mean the guide.
- **Parallel with:** LW-02, LW-03.

### LW-02 Shared design kit

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** one set of tokens and components for the site, matching the app.
- **Scope in:** `site-kit/tokens.css` and the Docusaurus variable mapping (replacing the hand-picked
  values in `custom.css`), display type sizes, the components listed under "Shared design kit", a
  kitchen-sink page at `/site-kit` (`noindex`) showing every component in light and dark, the MIT
  `LICENSE` and a short `README.md` in the kit folder, the token-sync and contrast tests. **Out:**
  page content.
- **Files:** `docs/src/site-kit/` (new: `tokens.css`, `components/*.tsx`, `LICENSE`, `README.md`,
  `tokens.test.ts`), `docs/src/css/custom.css`, `docs/src/pages/site-kit.tsx` (new), `docs/package.json`
  (a `test` script if none; no new runtime dependency).
- **Depends on:** D9, D10 approved.
- **Steps:** copy token values from `apps/web/src/theme.css`; keep the docs' darker primary only if
  the contrast test needs it, and say why in one comment; build components with CSS modules and the
  tokens only; buttons have one size.
- **Tests:** token-sync test; contrast test in both modes; build.
- **Acceptance:** changing a token in the app's `theme.css` without the kit fails the test; the
  kitchen-sink page passes axe in light and dark.
- **UX checks:** C1, C2, C5, W1; HIG review of the kitchen-sink page: one control size, one primary
  action per section, consistent radii; extremes: a 60-character heading, a 3-line button label at
  360 px, 200% text.
- **Risks:** Docusaurus's own styles overriding the kit; scope component styles with CSS modules.
- **Parallel with:** LW-01, LW-03.

### LW-03 Screenshot set

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** repeatable, good-looking screenshots of the real app for the site, in light and dark.
- **Scope in:** a Playwright script that seeds a demo library (the e2e fixtures, with real openly
  licensed photos and credits), opens the main screens at a fixed window size, and writes PNGs plus
  AVIF and WebP copies; a list of the shots (Collection, species page, Gallery and search, photo map,
  trip, stats, import progress, settings); credits for every photo shown. **Out:** marketing copy.
- **Files:** `e2e/site-screenshots/` (new script), `docs/static/img/site/` (outputs), `docs/docs/credits.md`
  (photo credits).
- **Depends on:** none (uses the existing e2e setup).
- **Steps:** reuse the e2e seed helpers; fixed date and locale; no personal paths or names visible;
  one command, re-runnable, writes only changed files.
- **Tests:** the script runs twice and the second run changes nothing.
- **Acceptance:** each shot exists in light and dark at 2x, under 250 KB as AVIF.
- **UX checks:** S2, S4, S7 (no `undefined`, no blank tiles, realistic counts); the reviewer looks at
  every shot.
- **Risks:** photo licences: only CC0, CC BY or the maintainer's own photos, credited.
- **Parallel with:** LW-01, LW-02.

### LW-04 Home page

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** a visitor understands Lifer in one screen and knows where to click next.
- **Scope in:** hero (name, one-line description, Download and Self-host buttons, a screenshot);
  feature rows from the site map list; "Free and open source" strip (AGPL, no account, no tracking,
  your files stay yours); "Works with" section with integrations and the optional partner apps section
  read from `docs/src/data/partnerApps.json` (`[]`, hidden when empty); footer. **Out:** download
  logic (LW-05).
- **Files:** `docs/src/pages/index.tsx`, `docs/src/pages/index.module.css`, `docs/src/data/partnerApps.json`
  (new, `[]`), `docs/src/data/features.ts` (new).
- **Depends on:** LW-01, LW-02, LW-03.
- **Contracts:** `partnerApps.json` entries: `{ name, description, url, logo, logoDark }`; `url` must
  be a plain https URL with no query string (a test enforces it); at most a few entries, shown as
  `PartnerCard`s in the "Works with" section, never above it.
- **Steps:** copy first, then layout; every claim checked against the current release; headline and
  description under the W6 length.
- **Tests:** build; a unit test that rejects partner URLs with a query string or fragment; the empty
  file renders no heading.
- **Acceptance:** at 1440 px the hero, both buttons and a screenshot are above the fold; at 360 px the
  primary button is above the fold; the page meets the performance budgets.
- **UX checks:** W1, W3, W5, W6, W8, C5, S7, S8; HIG review in light and dark at 360, 768, 1440 and
  2560 px; extremes: 200% text, no JavaScript, a 60-character feature title.
- **Risks:** feature creep in copy; keep to what ships.
- **Parallel with:** LW-05, LW-06, LW-07.

### LW-05 Download page

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the right installer in one click, with honest notes.
- **Scope in:** at build time, read the latest GitHub release (version, date, assets, sizes) through
  the public API and render one `DownloadCard` per platform (macOS Apple silicon and Intel, Windows,
  Linux AppImage and deb); a tiny inline script that puts the visitor's platform first (no request,
  no storage); without JavaScript all cards show; SHA-256 checksums; requirements; "first launch"
  notes per platform; links to release notes and all releases; the docs workflow also runs on
  `release: published`. **Out:** changing release asset names.
- **Files:** `docs/src/pages/download.tsx`, `docs/src/plugins/latestRelease.ts` (new, a tiny local
  Docusaurus plugin that fetches at build time), `.github/workflows/docs.yml` (trigger).
- **Depends on:** LW-01, LW-02.
- **Contracts:** if the GitHub API call fails, the build still succeeds and the page links to
  `releases/latest` with a plain note; asset matching by suffix (`.dmg`, `-setup.exe`, `.AppImage`,
  `.deb`) from `.github/workflows/release.yml`'s naming.
- **Steps:** read `release.yml` for the exact asset names; use `GITHUB_TOKEN` in CI to avoid rate
  limits; never call GitHub from the visitor's browser.
- **Tests:** unit test for asset matching with a recorded API response, including a release with a
  missing platform; build with the network blocked falls back cleanly.
- **Acceptance:** after a release is published the page shows it without a manual edit; every link
  downloads the right file.
- **UX checks:** W4 (platform words), W7, W8, S9, S7; HIG review; extremes: 12 assets, a missing
  Linux build, no JavaScript, 360 px.
- **Risks:** Apple silicon versus Intel can't be detected reliably; show both with a one-line hint.
- **Parallel with:** LW-04, LW-06, LW-07.

### LW-06 Self-hosting page

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** someone with a NAS or home server knows in two minutes how to run Lifer.
- **Scope in:** "Desktop or server?" in a short table; a Docker Compose quick start copied from
  `docs/docs/install/docker.md` (single source: the page links into the guide rather than restating
  steps beyond the first command); TrueNAS (install as a custom app from the Compose file until a
  catalogue listing exists, worded without a date); reverse proxy, hardware acceleration, backups and
  connecting a desktop, as links; phone use through the server's web app. **Out:** new install docs.
- **Files:** `docs/src/pages/self-hosting.tsx`, `docs/docs/install/docker.md` (only if a fact is
  wrong).
- **Depends on:** LW-01, LW-02.
- **Steps:** commands are short single lines with a copy button; no environment setup beyond what the
  Docker guide already needs.
- **Tests:** build; every command on the page also appears in the guide (a small test greps for it).
- **Acceptance:** a reader can go from the page to a running server using only linked docs.
- **UX checks:** W1, W3, W5, W6; HIG review; extremes: 360 px with long commands (horizontal scroll
  inside the code block only).
- **Risks:** drift from the Docker guide; the grep test catches it.
- **Parallel with:** LW-04, LW-05, LW-07.

### LW-07 Open source, privacy and analytics

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the licence, the project and the privacy story are clear, and the one analytics script is
  disclosed.
- **Scope in:** `/open-source` (AGPL-3.0 in five plain sentences, links to the licence text, GitHub,
  contributing, code of conduct, credits, security policy, the AI policy page); the privacy page gains
  "Lifer itself never contacts us" near the top and a "This website" section (GitHub hosts it and
  sees your IP address like any website; Plausible counts page views without cookies or personal data;
  nothing else); the Plausible script added with `defer`, the site's domain, no extensions that
  collect more. **Out:** any app behaviour change.
- **Files:** `docs/src/pages/open-source.tsx`, `docs/docs/privacy.md`, `docs/docusaurus.config.ts`
  (`scripts` or `headTags`).
- **Depends on:** LW-01, D6 approved, the Plausible site created by the maintainer.
- **Steps:** the privacy text states facts only; the script is the only `<script src>` from another
  origin.
- **Tests:** build; LW-09's third-party request test.
- **Acceptance:** the privacy page lists every request a visitor's browser makes.
- **UX checks:** W1, W3, W5, W6; HIG review.
- **Risks:** a future docs plugin adding a request; LW-09's test catches it.
- **Parallel with:** LW-04, LW-05, LW-06.

### LW-08 SEO and Open Graph cards

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** good titles, previews and search listings.
- **Scope in:** titles and descriptions on the new pages and any docs page missing one; canonical
  URLs; JSON-LD on home and download; Open Graph cards for home, download, self-hosting, open source
  and a default for docs, rendered once from an HTML template with Playwright (no new dependency) and
  committed as images; `robots.txt`; Search Console verification by DNS TXT (replaces the HTML file
  for the new domain; the old file can stay). **Out:** search ads.
- **Files:** `docs/src/pages/*.tsx` (meta), `docs/static/img/og/` (new), `docs/scripts/og-cards.mjs`
  (new), `docs/static/robots.txt` (new), `docs/docusaurus.config.ts` (`image`, `metadata`).
- **Depends on:** LW-02, LW-04.
- **Steps:** titles "Page name | Lifer Wildlife Archive"; descriptions under 155 characters, no em
  dashes; cards at 1200 x 630 under 200 KB.
- **Tests:** a build-output test: every HTML page has one title, one description, one canonical on the
  new domain; the relay page has `noindex`.
- **Acceptance:** sharing the home URL in a chat app shows the card and the right title.
- **UX checks:** W1, W5, W6; HIG look at each card at full size and at 300 px wide.
- **Risks:** name confusion with other "Lifer" apps; always use the full name in titles.
- **Parallel with:** LW-05, LW-06, LW-07.

### LW-09 Quality gates: accessibility, performance, links and requests

- **Model:** Sonnet 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the bars in "Quality bars" are checked in CI on every docs change.
- **Scope in:** a Playwright job that serves the built site and, for every sitemap URL in light and
  dark at 360 and 1440 px, runs axe-core (AA rules) and records requests, failing on any origin not in
  an allowlist (the site itself and Plausible); Lighthouse CI on the marketing pages with the budgets;
  `check:em-dashes` over `docs/`; external link check weekly (not on every PR). **Out:** fixing
  failures in other packages' pages (reported back to them).
- **Files:** `.github/workflows/docs.yml` (a quality job), `docs/tests/site-quality.spec.ts` (new),
  `docs/lighthouserc.json` (new), `scripts/check-em-dashes.*` (extend the path list if needed).
- **Depends on:** LW-01; runs against whatever pages exist.
- **Steps:** keep the job under 10 minutes; axe results summarised in the job log.
- **Tests:** a deliberately bad fixture page (low contrast, missing alt, a third-party image) fails
  each check, then is removed.
- **Acceptance:** CI fails on a contrast error, an unknown request origin, a budget overrun or an em
  dash.
- **UX checks:** none of its own.
- **Risks:** Lighthouse noise in CI; use the median of three runs.
- **Parallel with:** LW-02 to LW-08.

### LW-10 Domain cut-over

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the site lives at `liferwildlife.com`, and every old link lands on the same page.
- **Scope in:** a runbook the maintainer follows (buy both domains, move DNS to Cloudflare, add the
  GitHub Pages custom domain, wait for the certificate, enforce HTTPS, add the `.app` redirect rule);
  `docs/static/CNAME`; config defaults to the new domain; every `sparklysparkspark.github.io/lifer-app`
  reference in the repo updated (`apps/web/src/lib/docs.ts` `DOCS_BASE_URL`, `README.md`,
  `apps/desktop/README.md`, docs pages, the OpenAPI description if it links docs); verification that
  the old URLs redirect with path, query string and fragment intact. **Out:** the iNaturalist relay
  constant (LW-11).
- **Files:** `docs/static/CNAME` (new), `docs/docusaurus.config.ts`, `apps/web/src/lib/docs.ts`,
  `README.md`, `apps/desktop/README.md`, any other file the grep finds, `docs/docs/contributing/releasing.md`
  (a line on the domain), this plan (runbook appendix).
- **Depends on:** domains bought (maintainer), D3, D4, D5 approved, LW-01.
- **Steps:** grep the whole repo (excluding `node_modules`, `dist`, build output) for the old host;
  before cut-over, list the old sitemap's URLs; after, request each old URL and assert a 301 to the
  same path on the new domain and a 200 there; test a URL with a query string and one with a
  fragment.
- **Tests:** the URL check script, kept in `docs/scripts/check-redirects.mjs` for later; web unit test
  for `docsUrl`.
- **Acceptance:** zero old URLs return 404; the app's Help links open the new domain; HTTPS enforced
  on both domains; `.app` redirects keep the path.
- **UX checks:** W8 (link text still matches destinations).
- **Risks:** GitHub's redirect behaviour differs from what is documented: fall back to Cloudflare
  Pages for the new domain plus a generated stub site on the old Pages project (one HTML file per old
  route with `<meta http-equiv="refresh">`, a canonical link and a script that keeps query and
  fragment). Certificate issuance can take an hour; schedule it, don't announce during it.
- **Parallel with:** LW-02 to LW-09 (only `docusaurus.config.ts` is shared; this package owns `url`
  and `baseUrl`).

### LW-11 iNaturalist relay on the final domain

- **Model:** Opus 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** the iNaturalist sign-in redirect URI is `https://liferwildlife.com/inat-callback/` before the
  registration is finalised, and sign-in keeps working through the move.
- **Scope in:** `INAT_RELAY_REDIRECT_URI` in `packages/core/src/config.ts`; the `RELAY` constants in
  `apps/api/src/inaturalist/routes.integration.test.ts` and `routes.desktop.integration.test.ts`; the
  relay page file stays at `docs/static/inat-callback/index.html` (its test path is unchanged); a
  check that the old relay URL redirects with the full query string; the note for the maintainer of
  exactly what to enter in iNaturalist's application settings. **Out:** any change to the relay logic.
- **Files:** `packages/core/src/config.ts`, the two integration tests, `docs/docs/guides/inaturalist.md`
  only if it names the URL.
- **Depends on:** LW-10 live and verified.
- **Contracts:** the relay page keeps `noindex`, `no-referrer`, and gains no analytics script (LW-07
  must exclude it; the Plausible tag is added only to non-relay pages, or the relay stays a static
  file outside the theme, which it already is).
- **Steps:** change the constant; run the relay tests; manual sign-in from a desktop build and a
  server build once the client id exists.
- **Tests:** `relayState.test.ts` and the iNaturalist integration tests on `lifer_test`; a scripted
  request to the old URL with `?code=x&state=y` lands on the new URL with both parameters.
- **Acceptance:** the redirect URI in the iNaturalist registration and in the code match exactly,
  including the trailing slash.
- **UX checks:** the relay page in light and dark at 360 px; S1 for the invalid-link message.
- **Risks:** the registration under review already names the old URL: ask iNaturalist to update it or
  edit it after approval (open question 2); keep the old URL redirecting indefinitely either way. The
  analytics script must never load on the relay page, since it would see the sign-in code in the URL.
- **Parallel with:** LW-04 to LW-09.

### LW-12 Launch-day checklist and release hooks

- **Model:** Haiku 5.5 builds it; an Opus 5.5 reviewer checks it against the acceptance criteria, `ux-rules.md` and screenshots before hand-back.
- **Goal:** a short, ordered checklist the maintainer runs on launch day, and the small chores that
  make releases update the site.
- **Scope in:** the checklist below kept as a runnable list in `docs/docs/contributing/releasing.md`;
  remove or update the beta announcement bar; confirm the download page shows 1.0; the partner apps
  data file filled only if content was provided. **Out:** announcements in other places.
- **Files:** `docs/docs/contributing/releasing.md`, `docs/docusaurus.config.ts` (announcement bar).
- **Depends on:** all others.
- **Tests:** LW-09 passes on the release commit.
- **Acceptance:** the maintainer can run the list top to bottom in under an hour.
- **UX checks:** W1, W5.
- **Risks:** none notable.
- **Parallel with:** none (last).

## Order

```
Domains bought --> LW-10 --> LW-11 --> iNaturalist registration finalised
LW-01 --> LW-04 --> LW-08
LW-02 --/   LW-05, LW-06, LW-07 (after LW-01, LW-02)
LW-03 --/
LW-09 alongside everything
LW-12 last
```

## Milestones

| Milestone | Packages | When, relative to Lifer's releases | Effort |
|---|---|---|---|
| **A. New domain** | LW-01, LW-10, LW-11 | As soon as the domains are bought; before the iNaturalist registration is finalised and before the public beta | 2 to 3 days |
| **B. New site** | LW-02 to LW-08 | Before the public beta opens, so testers download from the new site | 6 to 8 days |
| **C. Gates** | LW-09 | Alongside B; must pass before the beta announcement | 1 to 2 days |
| **D. Launch** | LW-12 | Lifer 1.0 launch day | Half a day |
| **Total** | | | **about 2 to 3 weeks for one developer with sub-agents** |

## Running costs the maintainer pays

| Item | Cost (approximate, check before buying) | When |
|---|---|---|
| `liferwildlife.com` | about $11 a year | Milestone A, now |
| `liferwildlife.app` | about $15 a year | Milestone A, now |
| Cloudflare DNS and redirect rule | free | Milestone A |
| GitHub Pages hosting and downloads | free | already |
| Plausible | from about $9 a month (a free trial first) | Milestone B, when LW-07 lands |

## Launch-day checklist

1. Release 1.0 published on GitHub; the docs workflow rebuilt the site (download page shows 1.0).
2. LW-09 green on the release commit; spot-check home and download on a phone in dark mode.
3. Beta announcement bar removed or reworded.
4. Old-URL redirect check script run against the live site.
5. iNaturalist sign-in tested from the release build (desktop and server).
6. Open Graph card checked by pasting the home URL into a chat app.
7. Plausible receiving page views; no other third-party requests (browser dev tools, home and
   download).
8. Partner apps section: filled only if content was provided for this release; otherwise the file
   stays `[]`.
9. Announcements link to plain `https://liferwildlife.com/` URLs with no tags.

## Standing rules for every package

1. Never commit, branch, stash or open a PR. Leave changes uncommitted and report them.
2. No em dashes anywhere: copy, comments, docs, commit message drafts. `check:em-dashes` passes.
3. Short why-comments only; no history or test stories.
4. Plain, honest copy: what Lifer does today, in a newcomer's words.
5. No tracking scripts beyond the cookie-free analytics; no third-party fonts, embeds or pixels; no
   cookies; plain URLs with no tags.
6. No dark patterns: no pre-ticked boxes, fake urgency, hidden links or confusing buttons.
7. Every page passes contrast and accessibility checks (WCAG 2.2 AA) in light and dark.
8. Design for extremes: long names, 360 px screens, 200% text, dark mode, no JavaScript.
9. Shared kit components and tokens only; extend the kit rather than styling locally.
10. Targeted edits only: other sessions may own uncommitted changes. Lifer tests use `lifer_test`.
11. Lockfile changes only with `npx -y npm@11`.
12. Commands for the maintainer to paste are short single lines.

## Sub-agent briefing

```
You are working on [LW-xx]: [title], one package of the Lifer website plan.

Repo: /Users/judahstarkey/Development/lifer-app/ (public, AGPL). Site: docs/ (Docusaurus).
Work only in: [files from the package].

Read first
1. The package text below.
2. /Users/judahstarkey/Development/lifer-app/docs/plans/lifer-website-plan.md sections
   "Decisions", "Shared design kit", "Quality bars" and "Standing rules".
3. /Users/judahstarkey/Development/lifer-app/docs/plans/ux-rules.md for any page or component.

Rules (non-negotiable)
- Never git commit, branch, stash or open a PR.
- No em dashes anywhere. Short why-comments only. Plain, honest copy.
- No third-party scripts, fonts or embeds except the approved cookie-free analytics. No cookies.
  Plain URLs with no tags.
- No dark patterns. WCAG 2.2 AA in light and dark. Design for extremes (360 px, long text, 200%
  text, dark mode, no JavaScript).
- Kit components and tokens only. Targeted edits; others may own uncommitted changes.
- If the package depends on an unanswered NEEDS MAINTAINER APPROVAL decision, stop and ask.

Done means
- Acceptance criteria met; docs build passes; LW-09 checks pass for your pages.
- For pages: screenshots at 360 and 1440 px, light and dark; HIG checklist and ux-rules IDs checked.

Report back (under 300 words): what changed (absolute paths), tests and results, screenshot paths,
rules checked, anything blocked, a one-line suggested commit message (no AI attribution).
```

## Open questions

1. **Framework, repo and hosting (D1, D2, D4).** Recommendation: Docusaurus, in `lifer-app/docs/`,
   on GitHub Pages with a custom domain.
2. **The iNaturalist registration under review.** If it already names the `github.io` relay URL,
   either ask iNaturalist to change it before approval or edit it after. Recommendation: change it to
   `https://liferwildlife.com/inat-callback/` as soon as LW-10 is verified; keep the old URL
   redirecting forever.
3. **Canonical domain (D3).** Recommendation: `.com` canonical, `.app` redirects.
4. **Analytics (D6).** Recommendation: Plausible; Cloudflare Web Analytics if a free option matters
   more.
5. **Intro at `/intro` (D5).** Recommendation: yes; it is the only path that changes.
6. **A release-notes email list for Lifer.** Recommendation: no; GitHub release notifications and
   the changelog cover it without collecting addresses.
7. **Kit licence (D9).** Recommendation: MIT for `docs/src/site-kit/` only; the rest stays AGPL.
8. **Partner apps section.** Recommendation: build the empty, hidden-when-empty section now; content
   arrives separately and is approved by the maintainer before it is added.

## Appendix: route table

Filled by LW-01 from the build's sitemap (before and after), and used by LW-10's redirect check.

Built by LW-01 (2026-10-24). `/` was the docs intro and is now the home page; the intro is `/intro`. Every other path is unchanged.

| Route | Change |
|---|---|
| `/` | same |
| `/api/overview` | same |
| `/code-signing` | same |
| `/contributing/ai-policy` | same |
| `/contributing/architecture` | same |
| `/contributing/code-standards` | same |
| `/contributing/data-model` | same |
| `/contributing/data-pipeline` | same |
| `/contributing/database-migrations` | same |
| `/contributing/decisions` | same |
| `/contributing/decisions/0001-postgresql-everywhere` | same |
| `/contributing/decisions/0002-tauri-shell-with-node-sidecar` | same |
| `/contributing/decisions/0003-one-api-for-desktop-and-server` | same |
| `/contributing/decisions/0004-species-data-shipped-as-release-assets` | same |
| `/contributing/decisions/0005-catalog-separate-from-user-data` | same |
| `/contributing/decisions/0006-database-primary-files-carry-recovery-copy` | same |
| `/contributing/decisions/0007-library-layout-species-folders` | same |
| `/contributing/decisions/0008-in-process-onnx-inference` | same |
| `/contributing/decisions/0009-compiled-server` | same |
| `/contributing/decisions/0010-photo-license-policy` | same |
| `/contributing/decisions/0011-typebox-validation-and-generated-openapi` | same |
| `/contributing/decisions/0012-no-state-management-library` | same |
| `/contributing/desktop-app` | same |
| `/contributing/development` | same |
| `/contributing/imports-and-metadata` | same |
| `/contributing/rebuilding-data` | same |
| `/contributing/releasing` | same |
| `/contributing/review-process` | same |
| `/contributing/state-and-sync` | same |
| `/contributing/testing` | same |
| `/contributing/translating` | same |
| `/credits` | same |
| `/download` | new |
| `/faq` | same |
| `/getting-started` | same |
| `/guides/albums-and-sharing` | same |
| `/guides/collection-and-checklists` | same |
| `/guides/culling-with-other-apps` | same |
| `/guides/ebird-import` | same |
| `/guides/gallery-and-search` | same |
| `/guides/importing` | same |
| `/guides/inaturalist` | same |
| `/guides/library-folders` | same |
| `/guides/metadata-and-file-names` | same |
| `/guides/offline-packs-and-map` | same |
| `/guides/photo-map` | same |
| `/guides/stats` | same |
| `/guides/trash` | same |
| `/guides/trips` | same |
| `/install` | same |
| `/install/backup-restore` | same |
| `/install/connect-desktop-to-server` | same |
| `/install/desktop` | same |
| `/install/docker` | same |
| `/install/environment-variables` | same |
| `/install/hardware-acceleration` | same |
| `/install/requirements` | same |
| `/install/reverse-proxy` | same |
| `/install/upgrading` | same |
| `/intro` | new |
| `/open-source` | new |
| `/privacy` | same |
| `/roadmap` | same |
| `/search` | same |
| `/security-model` | same |
| `/self-hosting` | new |
| `/settings` | same |
| `/support` | same |
| `/troubleshooting` | same |
