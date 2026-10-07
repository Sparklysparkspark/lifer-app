// The GitHub repo releases are published to, for update checks and release-note links.
export const GITHUB_REPO = "Sparklysparkspark/lifer-app";

// Dev builds report this version and would otherwise always see an "update".
export const DEV_BUILD_VERSION = "0.1.0";

// Mac release zips are named by architecture (release.yml's matrix `asset`).
const MAC_ZIP_BY_ARCH: Record<string, string> = { arm64: "Lifer-macos-arm64.zip", x64: "Lifer-macos-x64.zip" };

/** The manual-update download for this Mac, or the release's page to pick from when the desktop
 *  app didn't say which architecture it runs on. */
export function macUpdateDownloadUrl(version: string, arch: string | undefined): string {
  const zip = arch ? MAC_ZIP_BY_ARCH[arch] : undefined;
  return zip
    ? `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${zip}`
    : `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`;
}
