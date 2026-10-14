// The region tree is World > continent > country > province, where a country with familiar
// regional groupings has them in between: country > vernacular group > province (Thailand >
// Northern Thailand > Chiang Mai). A group is a country's child with children of its own; its
// checklist is its provinces' together. A province shown under its continent instead, the
// Galapagos pattern, names its country in home_country_id and stays that country's for data.
//
// SQL builders take the region id as an SQL expression ($1, c.id) and return a subquery.

const childless = (alias: string) => `NOT EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = ${alias}.id)`;

/** Ids of every region below `region`: a country's groups and all its provinces, including any
 *  shown under its continent. */
export const descendantIdsSql = (region: string): string =>
  `SELECT d.id FROM regions d WHERE d.parent_id = ${region} OR d.home_country_id = ${region} OR d.parent_id IN (SELECT g.id FROM regions g WHERE g.parent_id = ${region})`;

/** Ids of a country's provinces, grouped or not, including any shown under its continent. */
export const provinceIdsSql = (country: string): string =>
  `SELECT p.id FROM regions p
   WHERE (p.parent_id = ${country} OR p.home_country_id = ${country}
          OR p.parent_id IN (SELECT g.id FROM regions g WHERE g.parent_id = ${country}))
     AND ${childless("p")}`;

/** Ids of a country's vernacular groups. */
export const groupIdsSql = (country: string): string =>
  `SELECT g.id FROM regions g WHERE g.parent_id = ${country} AND NOT (${childless("g")})`;

/** (id, name) of every country: World > continent > country, without provinces shown there. */
export const COUNTRIES_SQL = `SELECT c.id, c.name FROM regions c
   JOIN regions cont ON cont.id = c.parent_id
   JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
   WHERE c.home_country_id IS NULL`;

/** (id, country_id) of every province of every country. */
export const PROVINCES_WITH_COUNTRY_SQL = `SELECT p.id, c.id AS country_id FROM (${COUNTRIES_SQL}) c
   JOIN regions p ON p.parent_id = c.id OR p.home_country_id = c.id
   WHERE ${childless("p")}
   UNION ALL
   SELECT p.id, c.id FROM (${COUNTRIES_SQL}) c
   JOIN regions g ON g.parent_id = c.id
   JOIN regions p ON p.parent_id = g.id
   WHERE ${childless("p")}`;
