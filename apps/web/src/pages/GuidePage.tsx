import { Fragment } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { SPECIES_DOWNLOADS_PATH } from "../lib/speciesDownloads";

interface Step {
  title: string;
  /** Message keys, one per paragraph. */
  body: string[];
}

function PageLink({ to, children }: { to: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <Link to={to} state={{ backLabel: t("guide.title") }} className="font-medium text-ink underline">
      {children}
    </Link>
  );
}

// Tags the guide's messages use. Link tags avoid HTML void names like <link>, which Trans can't wrap.
const COMPONENTS = {
  strong: <strong />,
  term: <span className="font-medium text-ink" />,
  code: <code className="text-footnote" />,
  regionsLink: <PageLink to={SPECIES_DOWNLOADS_PATH} />,
  importLink: <PageLink to="/import" />,
  tripsLink: <PageLink to="/albums?view=trips" />,
  galleryLink: <PageLink to="/gallery" />,
  albumsLink: <PageLink to="/albums" />,
  statsLink: <PageLink to="/stats" />,
  libraryLink: <PageLink to="/settings/library" />,
  storageLink: <PageLink to="/settings/storage" />,
  archivedLink: <PageLink to="/archived" />,
  speciesLink: <PageLink to="/settings/species" />,
};

function Paragraphs({ keys }: { keys: string[] }) {
  return keys.map((key, i) => (
    <Fragment key={key}>
      {i > 0 && (
        <>
          <br />
          <br />
        </>
      )}
      <Trans i18nKey={key} components={COMPONENTS} />
    </Fragment>
  ));
}

const STEPS: Step[] = [
  { title: "guide.steps.regions.title", body: ["guide.steps.regions.body"] },
  { title: "guide.steps.upload.title", body: ["guide.steps.upload.body", "guide.steps.upload.counts"] },
  { title: "guide.steps.bulk.title", body: ["guide.steps.bulk.body"] },
  { title: "guide.steps.raw.title", body: ["guide.steps.raw.body"] },
  { title: "guide.steps.trip.title", body: ["guide.steps.trip.body", "guide.steps.trip.folders"] },
  { title: "guide.steps.browse.title", body: ["guide.steps.browse.body"] },
];

export default function GuidePage() {
  const { t } = useTranslation();
  const species = t("guide.library.speciesName");
  // Folder names are what Lifer writes on disk, so only the placeholders are translated.
  const layout = `Birds/<${species}>/Adjusted/<${t("guide.library.editedJpeg")}>\nBirds/<${species}>/RAW/<${t("guide.library.matchingRaw")}>`;
  const yearFolder = `Wildlife <${t("guide.library.yearTaken")}>/`;
  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky title={t("guide.title")} backFallbackTo="/settings" backLabel={t("nav.settings")} />
      <main className="mx-auto max-w-3xl space-y-section p-page">
        <section className="space-y-item">
          <h2 className="text-title-3 font-semibold text-ink">{t("guide.stepsTitle")}</h2>
          <Panel as="ol" grouped>
            {STEPS.map((step, index) => (
              <li key={step.title} className="p-panel">
                <h3 className="text-callout font-semibold text-ink">
                  <span className="mr-2 text-accent">{index + 1}.</span>
                  {t(step.title)}
                </h3>
                <p className="mt-1 text-callout text-muted">
                  <Paragraphs keys={step.body} />
                </p>
              </li>
            ))}
          </Panel>
        </section>

        <section className="space-y-2">
          <h2 className="text-title-3 font-semibold text-ink">{t("guide.library.title")}</h2>
          <Panel className="text-callout text-muted">
            <p>
              <Trans i18nKey="guide.library.intro" components={COMPONENTS} />
            </p>
            <pre className="mt-2 overflow-x-auto rounded-control bg-surface-muted p-2 text-footnote text-ink">
              {layout}
            </pre>
            <p className="mt-2">
              <Trans i18nKey="guide.library.folderLayout" values={{ folder: yearFolder }} components={COMPONENTS} />
            </p>
            <p className="mt-2">
              <Trans i18nKey="guide.library.drives" components={COMPONENTS} />
            </p>
          </Panel>
        </section>

        <section className="space-y-2">
          <h2 className="text-title-3 font-semibold text-ink">{t("guide.faqTitle")}</h2>
          <Panel grouped>
            <FaqItem question={t("guide.faq.uploadPaths.question")}>
              <Trans i18nKey="guide.faq.uploadPaths.answer" components={COMPONENTS} />
            </FaqItem>
            <FaqItem question={t("guide.faq.externalDrive.question")}>
              <Trans i18nKey="guide.faq.externalDrive.answer" components={COMPONENTS} />
            </FaqItem>
            <FaqItem question={t("guide.faq.undownloaded.question")}>
              <Trans i18nKey="guide.faq.undownloaded.answer" components={COMPONENTS} />
            </FaqItem>
            <FaqItem question={t("guide.faq.rarity.question")}>
              {t("guide.faq.rarity.intro")}
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {RARITY_TIERS.map((key) => (
                  <li key={key}>
                    <Trans i18nKey={key} components={COMPONENTS} />
                  </li>
                ))}
              </ul>
              <br />
              <Paragraphs keys={RARITY_NOTES} />
            </FaqItem>
            <FaqItem question={t("guide.faq.share.question")}>
              <Trans i18nKey="guide.faq.share.answer" components={COMPONENTS} />
            </FaqItem>
            <FaqItem question={t("guide.faq.archived.question")}>
              <Trans i18nKey="guide.faq.archived.answer" components={COMPONENTS} />
            </FaqItem>
            <FaqItem question={t("guide.faq.otherTaxa.question")}>
              <Trans i18nKey="guide.faq.otherTaxa.answer" components={COMPONENTS} />
            </FaqItem>
          </Panel>
        </section>
      </main>
    </div>
  );
}

const RARITY_TIERS = [
  "guide.faq.rarity.common",
  "guide.faq.rarity.occasional",
  "guide.faq.rarity.uncommon",
  "guide.faq.rarity.rare",
  "guide.faq.rarity.legendary",
];
const RARITY_NOTES = ["guide.faq.rarity.tight", "guide.faq.rarity.badges", "guide.faq.rarity.endangered"];

function FaqItem({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <details className="group p-4">
      <summary className="cursor-pointer list-none text-callout font-medium text-ink marker:content-none">
        <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
        {question}
      </summary>
      <p className="mt-2 pl-4 text-callout text-muted">{children}</p>
    </details>
  );
}
