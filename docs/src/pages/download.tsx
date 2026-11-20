import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { usePluginData } from "@docusaurus/useGlobalData";
import { ButtonLink, Callout, DownloadCard, Hero, PlatformPicker, Section } from "../site-kit/components";
import type { LatestRelease } from "../plugins/latestRelease";

const RELEASES = "https://github.com/Sparklysparkspark/lifer-app/releases";
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

export default function Download() {
  const rel = usePluginData("latest-release") as LatestRelease | null;
  const a = rel?.assets ?? {};
  const link = (x: { url: string; size: number } | undefined, label: string, primary = false) =>
    x ? [{ label: `${label} (${mb(x.size)})`, href: x.url, primary }] : [];
  return (
    <Layout title="Download" description="Download Lifer for Mac, Windows or Linux, free and open source.">
      <Hero
        title="Download Lifer"
        lede={rel ? `Version ${rel.version}, released ${rel.date}. Free for Mac, Windows and Linux.` : "Free for Mac, Windows and Linux."}
        actions={
          <ButtonLink href={rel?.url ?? `${RELEASES}/latest`} variant="secondary">
            Release notes
          </ButtonLink>
        }
      />
      <Section title="Choose your computer">
        {rel ? (
          <PlatformPicker>
            <DownloadCard platform="mac" title="Mac" note="macOS 14 or later. Pick Apple silicon for an M1 or newer Mac, Intel for older ones. The Apple menu, About This Mac, shows which you have." links={[...link(a.macArm, "Apple silicon", true), ...link(a.macIntel, "Intel")]} />
            <DownloadCard platform="windows" title="Windows" note="64-bit Intel or AMD." links={link(a.windows, "Installer", true)} />
            <DownloadCard platform="linux" title="Linux" note="64-bit Intel or AMD. The AppImage runs anywhere; the deb is for Debian, Ubuntu and similar." links={[...link(a.linuxAppImage, "AppImage", true), ...link(a.linuxDeb, "deb")]} />
          </PlatformPicker>
        ) : (
          <Callout>
            The latest downloads are on the <a href={`${RELEASES}/latest`}>GitHub releases page</a>. Pick the file for your computer.
          </Callout>
        )}
      </Section>
      <Section title="First launch" muted>
        <ul>
          <li><strong>Mac:</strong> Lifer is not notarized by Apple, so macOS asks you to confirm the first launch in System Settings, Privacy and Security, with Open Anyway.</li>
          <li><strong>Windows:</strong> run the installer, then open Lifer from the Start menu.</li>
          <li><strong>Linux:</strong> make the AppImage executable and run it, or install the deb.</li>
        </ul>
        <p>
          Step by step in <Link to="/install/desktop">Install the desktop app</Link>, with <Link to="/install/requirements">requirements</Link>. Prefer a server? See <Link to="/self-hosting">self-hosting</Link>.
        </p>
      </Section>
      <Section title="Verify and older versions">
        <p>
          {rel?.sums ? <>Every release lists SHA-256 checksums in <a href={rel.sums}>SHA256SUMS</a>. </> : null}
          All versions are on the <a href={RELEASES}>releases page</a>.
        </p>
      </Section>
    </Layout>
  );
}
