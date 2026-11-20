// Field-guide order for species lists: related species together, as in eBird and printed guides.
// species.sort_order holds a published sequence where the catalog has one; without it, species
// are ordered by group, then (for birds) the Clements order sequence, then order, family and name.

import { BIRD_ORDER_SEQUENCE, TAXON_CLASS_SEQUENCE as CLASS_SEQUENCE } from "@lifer/shared";

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The order's keys, ascending with nulls last, for species aliased `s`; the cast is each value's
 *  type, for keyset paging. Built from constants, so they're safe to inline. */
export function taxonomicOrderKeys(s = "s"): Array<{ expr: string; nullable: boolean; cast: string }> {
  return [
    { expr: `${s}.sort_order`, nullable: true, cast: "int" },
    {
      expr: `array_position(ARRAY[${CLASS_SEQUENCE.map(quote).join(",")}]::text[], ${s}.taxon_class)`,
      nullable: true,
      cast: "int",
    },
    {
      expr: `array_position(ARRAY[${BIRD_ORDER_SEQUENCE.map(quote).join(",")}]::text[], ${s}.taxon_order)`,
      nullable: true,
      cast: "int",
    },
    { expr: `${s}.taxon_order`, nullable: true, cast: "text" },
    { expr: `${s}.family`, nullable: true, cast: "text" },
    { expr: `${s}.scientific_name`, nullable: false, cast: "text" },
  ];
}

/** The ORDER BY list for species aliased `s`. */
export function taxonomicOrderBy(s = "s"): string {
  return taxonomicOrderKeys(s)
    .map((k) => `${k.expr}${k.nullable ? " NULLS LAST" : ""}`)
    .join(", ");
}
