import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { usePluginData } from "@docusaurus/useGlobalData";
import {
  ButtonLink,
  CardGrid,
  Hero,
  PartnerCard,
  PlatformButtons,
  ScreenshotFrame,
  Section,
} from "../site-kit/components";
import type { Partner, Shot } from "../site-kit/components";
import type { LatestRelease } from "../plugins/latestRelease";
import { beats, details, faq, trip } from "../data/features";
import partnerApps from "../data/partnerApps.json";
import siteStats from "../data/siteStats.json";
import PhotoWall from "../components/landing/PhotoWall";
import TripStory from "../components/landing/TripStory";
import TreeSection from "../components/landing/TreeSection";
import styles from "../components/landing/landing.module.css";

// Screenshots are 1600 x 1000 (scripts/capture-screenshots.mjs); the scatter is cropped to its card.
const SIZES: Record<string, [number, number]> = { "stats-scatter": [1220, 489], metadata: [900, 785] };
const img = (name: string, file: string): Shot => {
  const [width, height] = SIZES[name] ?? [1600, 1000];
  return { src: `/img/${file}.jpg`, width, height };
};
const shots = (name: string) => ({ light: img(name, name), dark: img(name, `${name}-dark`) });

/** The download buttons, straight to each platform's file when the release is known. */
function Downloads() {
  const a = (usePluginData("latest-release") as LatestRelease | null)?.assets ?? {};
  return (
    <PlatformButtons
      links={[
        { platform: "mac", label: "Download for Mac", href: a.macArm?.url ?? "/download" },
        { platform: "windows", label: "Download for Windows", href: a.windows?.url ?? "/download" },
        { platform: "linux", label: "Download for Linux", href: a.linuxAppImage?.url ?? "/download" },
      ]}
    />
  );
}

export default function Home() {
  const partners = partnerApps as Partner[];
  return (
    <Layout
      title="Lifer Wildlife Archive"
      description="A free photo library and life list for wildlife photographers. Your photos sorted by species, on your computer or your own server."
    >
      <Hero
        title="Your wildlife photos, sorted by species"
        lede="A photo library and life list for wildlife photographers. Every region's checklist fills in from the photos you take."
        actions={
          <div>
            <Downloads />
            <p className={styles.heroNote}>
              Free and open source. Intel Mac, deb and checksums on the <Link to="/download">download page</Link>, or{" "}
              <Link to="/self-hosting">run it on your own server</Link>.
            </p>
          </div>
        }
        media={<PhotoWall />}
      />

      <Section title={trip.title} intro={trip.intro}>
        <TripStory
          beats={beats}
          shot={shots}
          last={
            <>
              <TreeSection
                fallback={<ScreenshotFrame alt="The Tree of life as a circle" {...shots("tree-circle")} />}
              />
              <p className={styles.collectionNote}>Belize's land animals, with photos from this collection.</p>
            </>
          }
        />
      </Section>

      <Section title="Also in Lifer" muted>
        <ul className={styles.details}>
          {details.map((d) => (
            <li key={d.title}>
              <strong>{d.title}</strong>
              <span>{d.text}</span>
            </li>
          ))}
        </ul>
        {partners.length > 0 && (
          <>
            <h3>Partner apps</h3>
            <CardGrid>
              {partners.map((p) => (
                <PartnerCard key={p.url} partner={p} />
              ))}
            </CardGrid>
          </>
        )}
      </Section>

      <Section title="Questions">
        <div className={styles.faq}>
          {faq.map((q) => (
            <details key={q.q}>
              <summary>{q.q}</summary>
              <p>{q.a}</p>
            </details>
          ))}
          <p className={styles.credits}>
            More in the <Link to="/faq">FAQ</Link>.
          </p>
        </div>
      </Section>

      <Section title="Start your archive" muted>
        <div className={styles.closing}>
          <p>
            Checklists for {siteStats.countries} countries and territories and {siteStats.oceanAreas} ocean areas. Free
            and <Link to="/open-source">open source</Link>, with no account and <Link to="/privacy">no tracking</Link>.
            Your photos stay ordinary files in your own folders.
          </p>
          <p>Mac, Windows or Linux. Or a NAS with Docker or TrueNAS.</p>
          <div className={styles.closingActions}>
            <Downloads />
            <ButtonLink href="/self-hosting" variant="secondary">
              Self-host
            </ButtonLink>
          </div>
        </div>
      </Section>
    </Layout>
  );
}
