// speciesInGroup (packages/shared searchTaxonSynonyms.ts) in SQL: a FROM and WHERE over species s
// for the GroupPredicate passed as JSON in `param`. No rows when the parameter is null.
export const speciesInGroupSql = (param: string) => `
    FROM jsonb_to_record(${param}::jsonb) AS g(classes text[], orders text[], families text[], "excludeClasses" text[],
           "excludeOrders" text[], "excludeFamilies" text[], "excludeNameWords" text[], "includeNameWords" text[])
    JOIN species s
      ON lower(s.taxon_class) = ANY(g.classes) OR lower(s.taxon_order) = ANY(g.orders) OR lower(s.family) = ANY(g.families)
    WHERE NOT COALESCE(lower(s.taxon_class) = ANY(g."excludeClasses") OR lower(s.taxon_order) = ANY(g."excludeOrders")
                       OR lower(s.family) = ANY(g."excludeFamilies"), false)
      AND NOT COALESCE(lower(s.common_name) ~ ('\\m(' || array_to_string(g."excludeNameWords", '|') || ')\\M'), false)
      AND COALESCE(lower(s.common_name) ~ ('\\m(' || array_to_string(g."includeNameWords", '|') || ')\\M'), true)`;
