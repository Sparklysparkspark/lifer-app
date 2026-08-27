import { fetchGbifBackboneForKeys } from "../fetch/fetch-gbif-backbone.js";

const groups = {
  reptilia: [11592253, 11418114, 11493978, 11569602],
  amphibia: [131],
  cnidaria: [206, 352, 176, 205],
  echinodermata: [214, 221],
  mollusca_existing_scope: [982, 7390893, 9715180, 980],
  cephalopoda: [136],
  crustacea_decapoda: [637],
  sponges_tunicates: [105, 356],
};

let total = 0;
for (const [name, keys] of Object.entries(groups)) {
  const rows = await fetchGbifBackboneForKeys(keys);
  console.log(`${name}: ${rows.length}`);
  total += rows.length;
}
console.log("TOTAL new species across all these groups:", total);
