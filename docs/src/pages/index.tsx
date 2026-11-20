import Layout from "@theme/Layout";
import { ButtonLink, CardGrid, FeatureRow, Hero, PartnerCard, ScreenshotFrame, Section } from "../site-kit/components";
import type { Partner } from "../site-kit/components";
import { features, integrations } from "../data/features";
import partnerApps from "../data/partnerApps.json";
import styles from "./index.module.css";

const shot = (src: string) => ({ src, width: 1600, height: 1017 });

export default function Home() {
  const partners = partnerApps as Partner[];
  return (
    <Layout
      title="Lifer Wildlife Archive"
      description="A free photo library and life list for wildlife photographers. Your photos sorted by species, on your computer or your own server."
    >
      <Hero
        title="Lifer Wildlife Archive"
        lede="A photo library and life list for wildlife photographers. Your photos, sorted by species."
        actions={
          <>
            <ButtonLink href="/download">Download</ButtonLink>
            <ButtonLink href="/self-hosting" variant="secondary">
              Self-host
            </ButtonLink>
          </>
        }
        media={
          <ScreenshotFrame
            priority
            alt="The Collection page, showing a region's checklist"
            light={shot("/img/collection.jpg")}
          />
        }
      />
      <Section title="What Lifer does" muted>
        {features.map((f, i) => (
          <FeatureRow
            key={f.title}
            title={f.title}
            reverse={i % 2 === 1}
            shot={<ScreenshotFrame alt={f.alt} light={shot(f.image)} />}
          >
            {f.text}
          </FeatureRow>
        ))}
      </Section>
      <Section title="Free and open source">
        <ul className={styles.strip}>
          <li>
            <strong>AGPL-3.0</strong>
            <span>Free software. Read the code, change it, share it.</span>
          </li>
          <li>
            <strong>No account</strong>
            <span>Nothing to sign up for.</span>
          </li>
          <li>
            <strong>No tracking in the app</strong>
            <span>Lifer never contacts us unless you send a crash report.</span>
          </li>
          <li>
            <strong>Your files stay yours</strong>
            <span>Photos stay in your folders, in normal files.</span>
          </li>
        </ul>
      </Section>
      <Section title="Works with" muted>
        <ul className={styles.strip}>
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
    </Layout>
  );
}
