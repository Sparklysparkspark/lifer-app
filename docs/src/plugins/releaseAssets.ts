export interface Asset {
  name: string;
  size: number;
  url: string;
}
export type PlatformKey = "macArm" | "macIntel" | "windows" | "linuxAppImage" | "linuxDeb";

// Names come from .github/workflows/release.yml: Lifer-macos-arm64.zip, Lifer-macos-x64.zip,
// the NSIS .exe, the .AppImage and the .deb.
const matchers: Record<PlatformKey, (n: string) => boolean> = {
  macArm: (n) => /macos-arm64\.zip$/i.test(n),
  macIntel: (n) => /macos-x64\.zip$/i.test(n),
  windows: (n) => /\.exe$/i.test(n),
  linuxAppImage: (n) => /\.AppImage$/i.test(n),
  linuxDeb: (n) => /\.deb$/i.test(n),
};

/** One asset per platform; a missing platform is simply absent. */
export function matchAssets(assets: Asset[]): Partial<Record<PlatformKey, Asset>> {
  const out: Partial<Record<PlatformKey, Asset>> = {};
  for (const k of Object.keys(matchers) as PlatformKey[]) {
    const a = assets.find((x) => matchers[k](x.name));
    if (a) out[k] = a;
  }
  return out;
}
