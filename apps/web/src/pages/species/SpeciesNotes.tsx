import type { SpeciesDetail, SpeciesNotes as Notes } from "./types";

// Field-guide notes summarised from the species' Wikipedia article (migration 140). Each falls back
// to the Wikipedia text it replaces when a species has no notes: identification_notes stands in for
// description, habitat_notes for habitat_description.
export function SpeciesNotes({ species }: { species: SpeciesDetail["species"] }) {
  const identification = hasNotes(species.identification_notes) ? species.identification_notes : null;
  const habitat = hasNotes(species.habitat_notes) ? species.habitat_notes : null;
  // One credit for the section; both sets of notes come from the same article.
  const sourceUrl = identification?.source_url ?? habitat?.source_url ?? null;
  return (
    <>
      {identification ? (
        <NoteSections notes={identification} />
      ) : (
        species.description && (
          <p className="text-sm text-ink">
            {species.description}{" "}
            {species.description_source_url && (
              <a
                href={species.description_source_url}
                target="_blank"
                rel="noreferrer"
                className="text-muted hover:underline"
              >
                (Wikipedia)
              </a>
            )}
          </p>
        )
      )}
      {habitat ? (
        <NoteSections notes={habitat} />
      ) : (
        species.habitat_description && (
          <p className="text-sm text-ink">
            <span className="font-medium text-muted">Habitat: </span>
            {species.habitat_description}
          </p>
        )
      )}
      {(identification || habitat) && sourceUrl && (
        <p className="text-xs text-muted">
          Summarised from{" "}
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="hover:underline">
            Wikipedia
          </a>{" "}
          (CC BY-SA)
        </p>
      )}
    </>
  );
}

function hasNotes(notes: Notes | null | undefined): notes is Notes {
  return !!notes?.sections?.some((s) => s.bullets?.length > 0);
}

function NoteSections({ notes }: { notes: Notes }) {
  return (
    <div className="flex flex-col gap-2">
      {notes.sections.map((section) => (
        <div key={section.heading}>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">{section.heading}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink">
            {section.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
