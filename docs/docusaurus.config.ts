import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// Published to GitHub Pages by .github/workflows/docs.yml. DOCS_URL and DOCS_BASE_URL override
// the defaults, for a fork or a custom domain (a custom domain usually wants DOCS_BASE_URL=/).
const organizationName = "Sparklysparkspark";
const projectName = "lifer-app";
const repoUrl = `https://github.com/${organizationName}/${projectName}`;

const config: Config = {
  title: "Lifer",
  tagline: "A species-indexed photo archive and life list for wildlife photographers",
  favicon: "img/favicon.png",

  url: process.env.DOCS_URL ?? `https://${organizationName.toLowerCase()}.github.io`,
  baseUrl: process.env.DOCS_BASE_URL ?? `/${projectName}/`,
  organizationName,
  projectName,
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: {
    // .md files are plain CommonMark (so HTML comments and stray braces are fine); .mdx is MDX.
    format: "detect",
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: `${repoUrl}/edit/main/docs/`,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        docsRouteBasePath: "/",
        indexBlog: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    image: "img/social-card.jpg",
    announcementBar: {
      id: "beta-2026",
      content: `Lifer is in beta: back up before updating, and <a href="${repoUrl}/discussions">tell us what you think</a>.`,
      isCloseable: true,
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "",
      logo: {
        alt: "Lifer",
        src: "img/wordmark.png",
        srcDark: "img/wordmark-dark.png",
      },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/install", label: "Install", position: "left" },
        { to: "/api/overview", label: "API", position: "left" },
        { href: `${repoUrl}/releases/latest`, label: "Download", position: "right" },
        { href: repoUrl, label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Introduction", to: "/" },
            { label: "Getting started", to: "/getting-started" },
            { label: "Troubleshooting", to: "/troubleshooting" },
          ],
        },
        {
          title: "Install",
          items: [
            { label: "Requirements", to: "/install/requirements" },
            { label: "Desktop app", to: "/install/desktop" },
            { label: "Docker server", to: "/install/docker" },
            { label: "Upgrading", to: "/install/upgrading" },
            { label: "Backup and restore", to: "/install/backup-restore" },
          ],
        },
        {
          title: "Community",
          items: [
            { label: "Discussions", href: `${repoUrl}/discussions` },
            { label: "Issues", href: `${repoUrl}/issues` },
            { label: "Getting help", to: "/support" },
            { label: "Code of Conduct", href: `${repoUrl}/blob/main/CODE_OF_CONDUCT.md` },
          ],
        },
        {
          title: "Project",
          items: [
            { label: "GitHub", href: repoUrl },
            { label: "Releases", href: `${repoUrl}/releases` },
            { label: "Changelog", href: `${repoUrl}/blob/main/CHANGELOG.md` },
            { label: "Contributing", href: `${repoUrl}/blob/main/CONTRIBUTING.md` },
            { label: "Security", href: `${repoUrl}/security/policy` },
            { label: "Credits", to: "/credits" },
          ],
        },
      ],
      copyright: `Lifer is open source under the AGPL-3.0 license.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "yaml", "nginx", "python", "json", "ini"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
