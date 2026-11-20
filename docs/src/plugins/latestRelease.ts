import type { LoadContext, Plugin } from "@docusaurus/types";
import { matchAssets, type Asset } from "./releaseAssets.ts";

const API = "https://api.github.com/repos/Sparklysparkspark/lifer-app/releases/latest";

export interface LatestRelease {
  version: string;
  date: string;
  url: string;
  assets: ReturnType<typeof matchAssets>;
  sums?: string;
}

/** Fetches the latest release at build time; null on any failure, so the build never breaks. */
export default function latestRelease(_context: LoadContext): Plugin<LatestRelease | null> {
  return {
    name: "latest-release",
    async loadContent() {
      try {
        const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        const res = await fetch(API, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const r = await res.json();
        const all: Asset[] = r.assets.map((a: any) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
        return {
          version: String(r.tag_name).replace(/^v/, ""),
          date: String(r.published_at).slice(0, 10),
          url: r.html_url,
          assets: matchAssets(all),
          sums: all.find((a) => a.name === "SHA256SUMS")?.url,
        };
      } catch {
        return null;
      }
    },
    async contentLoaded({ content, actions }) {
      actions.setGlobalData(content);
    },
  };
}
