import Head from "@docusaurus/Head";
import Layout from "@theme/Layout";
import {
  ButtonLink,
  Callout,
  CardGrid,
  DownloadCard,
  FeatureRow,
  Hero,
  PartnerCard,
  PlatformPicker,
  ScreenshotFrame,
  Section,
} from "../site-kit/components";

const shot = { src: "/img/collection.jpg", width: 1600, height: 1000 };
const long = "A feature title that runs to sixty characters, to test wrapping";

export default function SiteKitPage() {
  return (
    <Layout title="Site kit" description="Every site kit component, for checking light and dark.">
      <Head>
        <meta name="robots" content="noindex" />
      </Head>
      <Hero
        title="Lifer Wildlife Archive"
        lede="One screen, one sentence about what Lifer does."
        actions={
          <>
            <ButtonLink href="/download">Download</ButtonLink>
            <ButtonLink href="/self-hosting" variant="secondary">
              Self-host
            </ButtonLink>
          </>
        }
        media={<ScreenshotFrame alt="The Collection page" light={shot} dark={shot} priority />}
      />
      <Section title="Features" intro="Rows with a screenshot and text." muted>
        <FeatureRow
          title={long}
          shot={<ScreenshotFrame alt="The Collection page" light={shot} dark={shot} caption="A caption" />}
        >
          Point Lifer at your photo folders and it finds the species.
        </FeatureRow>
        <FeatureRow
          title="Reversed row"
          reverse
          shot={<ScreenshotFrame alt="The Collection page" light={shot} dark={shot} />}
        >
          The text and screenshot swap sides on wide screens.
        </FeatureRow>
      </Section>
      <Section title="Downloads and cards">
        <PlatformPicker>
          <DownloadCard
            platform="mac"
            title="macOS"
            note="Apple silicon and Intel."
            links={[
              { label: "Download for Mac (Apple silicon)", href: "https://example.com/file0", primary: true },
              { label: "Intel", href: "https://example.com/file1" },
            ]}
          />
          <DownloadCard
            platform="windows"
            title="Windows"
            links={[{ label: "Download the installer", href: "https://example.com/file2", primary: true }]}
          />
          <DownloadCard
            platform="linux"
            title="Linux"
            note="AppImage or deb."
            links={[
              { label: "AppImage", href: "https://example.com/file3", primary: true },
              { label: "deb", href: "https://example.com/file4" },
            ]}
          />
        </PlatformPicker>
        <p />
        <CardGrid>
          <PartnerCard
            partner={{
              name: "Example partner with a very long name indeed",
              description: "What it does.",
              url: "https://example.com/",
              logo: "/img/icon.png",
              logoDark: "/img/icon-dark.png",
            }}
          />
        </CardGrid>
        <p />
        <Callout>
          <strong>Free and open source.</strong> No account, no tracking.
        </Callout>
      </Section>
    </Layout>
  );
}
