import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    {
      type: "category",
      label: "Install",
      collapsed: false,
      items: [
        "install/desktop",
        "install/docker",
        "install/reverse-proxy",
        "install/hardware-acceleration",
        "install/environment-variables",
        "install/backup-restore",
        "install/connect-desktop-to-server",
      ],
    },
    "getting-started",
    {
      type: "category",
      label: "Guides",
      collapsed: false,
      items: [
        "guides/importing",
        "guides/library-folders",
        "guides/collection-and-checklists",
        "guides/gallery-and-search",
        "guides/trips",
        "guides/albums-and-sharing",
        "guides/ebird-import",
        "guides/inaturalist",
        "guides/offline-packs-and-map",
        "guides/stats",
        "guides/trash",
      ],
    },
    "settings",
    "troubleshooting",
    "faq",
    {
      type: "category",
      label: "API",
      items: ["api/overview"],
    },
    {
      type: "category",
      label: "Contributing",
      items: ["contributing/development"],
    },
  ],
};

export default sidebars;
