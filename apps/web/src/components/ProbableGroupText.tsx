import { Trans } from "react-i18next";

export interface ProbableGroup {
  rank: "genus" | "family";
  /** Scientific name of the genus or family. */
  name: string;
  taxonClass: string | null;
}

// "Probably a Myotis" for a toss-up between close species. Display only: the user still picks a
// species, so a genus never becomes a capture's species or a lifer.
export default function ProbableGroupText({ group }: { group: ProbableGroup }) {
  // shortcut: a/an by first letter, fine for Latin names; a language with real articles needs its own rule.
  const article = /^[aeiou]/i.test(group.name) ? "an" : "a";
  return (
    <Trans
      i18nKey="species.suggestion.probably"
      values={{ rank: group.rank, name: group.name, article }}
      components={{ i: <i /> }}
    />
  );
}
