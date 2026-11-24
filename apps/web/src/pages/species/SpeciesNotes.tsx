import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { openExternal } from "../../lib/openExternal";
import type { SpeciesDetail, SpeciesNotes as Notes } from "./types";

/** A heading inside one of the species page's panel sections. */
export const SECTION_LABEL = "mb-1 text-callout font-semibold text-ink";

// Field-guide notes summarised from the species' Wikipedia article (CC BY-SA, so every view of
// that text carries the credit line below). A summary paragraph (migration 143) leads when there is one. Otherwise the bullet
// notes (migration 140) show, each falling back to the Wikipedia text it replaces:
// identification_notes stands in for description, habitat_notes for habitat_description.

/** One line of the About section, like a field guide entry: a muted label, then short phrases
 *  joined by middle dots. Plain text rather than chips, so the facts read as one line each. */
export function FactRow({
  label,
  items,
}: {
  label: string;
  items: Array<{ text: string; className?: string; title?: string }>;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-item text-callout leading-relaxed">
      <p className="text-muted">{label}</p>
      {/* Room around the dots keeps each phrase readable on its own. */}
      <p className="text-ink">
        {items.map((item, i) => (
          <span key={item.text}>
            {i > 0 && <span className="mx-1.5 text-muted">·</span>}
            <span className={item.className} title={item.title}>
              {i > 0 ? lowerFirst(item.text) : item.text}
            </span>
          </span>
        ))}
      </p>
    </div>
  );
}

// Mid-line phrases read as a list, not as sentences; an acronym ("IUCN") keeps its capitals.
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

const LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

/** The CC BY-SA credit Wikipedia text must carry; the source link is the article when known. */
export function WikipediaCredit({ url }: { url?: string | null }) {
  const link = (href: string) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className="hover:text-ink hover:underline"
    />
  );
  return (
    <p className="text-footnote text-muted">
      <Trans
        i18nKey="species.notes.credit"
        components={{ article: url ? link(url) : <span />, licence: link(LICENCE_URL) }}
      />
    </p>
  );
}

/** Credit for a summary written from another openly licensed source (FishBase, the Reptile
 *  Database), which names itself, its page and its licence on the row. */
function NotesCredit({ notes }: { notes: Notes }) {
  if (!notes.licence_url || !notes.licence) return <WikipediaCredit url={notes.source_url} />;
  const link = (href: string) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className="hover:text-ink hover:underline"
    />
  );
  return (
    <p className="text-footnote text-muted">
      <Trans
        i18nKey="species.notes.sourceCredit"
        values={{ source: notes.credit, licence: notes.licence }}
        components={{ page: notes.source_url ? link(notes.source_url) : <span />, licence: link(notes.licence_url) }}
      />
    </p>
  );
}

// Plain-description fallbacks are Wikipedia text only when their credit says so.
const fromWikipedia = (species: SpeciesDetail["species"]) => /wikipedia/i.test(species.description_credit ?? "");

/** `status` is a FactRow shown first, before the notes. */
export function SpeciesNotes({ species, status }: { species: SpeciesDetail["species"]; status?: ReactNode }) {
  const { t } = useTranslation();
  if (hasNotes(species.summary_notes))
    return (
      <div className="space-y-3">
        {status}
        <p className="text-callout leading-relaxed text-ink">{summaryText(species.summary_notes)}</p>
        <NotesCredit notes={species.summary_notes} />
      </div>
    );
  const identification = hasNotes(species.identification_notes) ? species.identification_notes : null;
  const habitat = hasNotes(species.habitat_notes) ? species.habitat_notes : null;
  // Both sets of notes flow through one set of columns, rather than each starting its own.
  if (identification && habitat)
    return (
      <div className="space-y-3">
        {status}
        <NoteSections notes={{ ...identification, sections: [...identification.sections, ...habitat.sections] }} />
        <WikipediaCredit url={identification.source_url ?? habitat.source_url} />
      </div>
    );
  // Fallback text is Wikipedia's too when its credit says so; one credit line covers everything shown.
  const wikipediaText =
    !!identification || !!habitat || (fromWikipedia(species) && !!(species.description || species.habitat_description));
  return (
    <div className="space-y-3">
      {status}
      {identification ? (
        <NoteSections notes={identification} />
      ) : (
        species.description && <p className="text-callout text-ink">{species.description}</p>
      )}
      {habitat ? (
        <NoteSections notes={habitat} />
      ) : (
        species.habitat_description && (
          <p className="text-callout text-ink">
            <span className="font-medium text-muted">{t("species.notes.habitatLabel")} </span>
            {species.habitat_description}
          </p>
        )
      )}
      {wikipediaText && (
        <WikipediaCredit url={identification?.source_url ?? habitat?.source_url ?? species.description_source_url} />
      )}
    </div>
  );
}

// The summary's bullets are the paragraph's sentences, in reading order.
function summaryText(notes: Notes): string {
  return notes.sections
    .flatMap((section) => section.bullets)
    .map((sentence) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`))
    .join(" ");
}

function hasNotes(notes: Notes | null | undefined): notes is Notes {
  return !!notes?.sections?.some((s) => s.bullets?.length > 0);
}

function NoteSections({ notes }: { notes: Notes }) {
  return (
    // Columns follow the space the notes get: one in the panel, up to three across the page.
    <div className="@container">
      <div className="columns-1 gap-10 @2xl:columns-2 @5xl:columns-3">
        {notes.sections.map((section) => (
          <div key={section.heading} className="mb-3 break-inside-avoid">
            <p className={SECTION_LABEL}>{section.heading}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-callout text-ink">
              {section.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
