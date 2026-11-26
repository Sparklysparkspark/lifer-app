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
import { details, faq, integrations, steps, tour } from "../data/features";
import partnerApps from "../data/partnerApps.json";
import siteStats from "../data/siteStats.json";
import Counter from "../components/landing/Counter";
import FeatureTour from "../components/landing/FeatureTour";
import RarityDemo from "../components/landing/RarityDemo";
import TreeSection from "../components/landing/TreeSection";
import styles from "../components/landing/landing.module.css";

const shot = (name: string): Shot => ({ src: `/img/${name}.jpg`, width: 1600, height: 1000 });
const dark = (name: string): Shot => shot(`${name}-dark`);

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
        eyebrow="Lifer Wildlife Archive"
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
        media={
          <div className={styles.heroMedia}>
            <ScreenshotFrame
              priority
              alt="The Collection page, showing Belize's checklist"
              light={shot("collection")}
              dark={dark("collection")}
            />
            <RarityDemo />
          </div>
        }
      />

      <Section title="A catalogue of the world's wildlife" muted>
        <ul className={styles.stats}>
          <li>
            <span className={styles.statValue}>
              <Counter value={siteStats.species} />
            </span>
            <span className={styles.statLabel}>species on regional checklists</span>
          </li>
          <li>
            <span className={styles.statValue}>
              <Counter value={siteStats.withPhoto} />
            </span>
            <span className={styles.statLabel}>of them with a reference photo</span>
          </li>
          <li>
            <span className={styles.statValue}>
              <Counter value={siteStats.countries} />
            </span>
            <span className={styles.statLabel}>countries and territories</span>
          </li>
          <li>
            <span className={styles.statValue}>
              <Counter value={siteStats.oceanAreas} />
            </span>
            <span className={styles.statLabel}>ocean areas for marine life</span>
          </li>
        </ul>
        <p className={styles.statsNote}>Counted from Lifer's species catalogue on {siteStats.date}.</p>
      </Section>

      <Section title="How it works">
        <ol className={styles.steps}>
          {steps.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        title="Explore your collection"
        intro="The Tree of life draws your collection as one circle. Green is what you've photographed. Click a group to zoom in, and the middle to step back out."
        muted
      >
        <TreeSection
          fallback={
            <ScreenshotFrame
              alt="The Tree of life as a circle"
              light={shot("tree-circle")}
              dark={dark("tree-circle")}
            />
          }
        />
        <p className={styles.sampleNote}>Sample data: real groups, made-up marks.</p>
      </Section>

      <Section title="A tour of Lifer">
        <FeatureTour stops={tour.map((t) => ({ ...t, light: shot(t.image), dark: dark(t.image) }))} />
      </Section>

      <Section title="Details that matter" muted>
        <ul className={styles.details}>
          {details.map((d) => (
            <li key={d.title}>
              <strong>{d.title}</strong>
              <span>{d.text}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Yours, and only yours">
        <ul className={styles.promise}>
          <li>
            <strong>Free software</strong>
            <span>
              AGPL-3.0 and non-commercial. Read the code, change it, share it.{" "}
              <Link to="/open-source">Open source</Link>
            </span>
          </li>
          <li>
            <strong>No account</strong>
            <span>Nothing to sign up for.</span>
          </li>
          <li>
            <strong>No tracking</strong>
            <span>
              Lifer never contacts us unless you send a crash report. <Link to="/privacy">Privacy</Link>
            </span>
          </li>
          <li>
            <strong>Your files stay yours</strong>
            <span>Normal files in your own folders, on your computer or your own server.</span>
          </li>
        </ul>
      </Section>

      <Section title="Works with" muted>
        <ul className={styles.details}>
          {integrations.map((i) => (
            <li key={i.name}>
              <strong>{i.name}</strong>
              <span>{i.text}</span>
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
