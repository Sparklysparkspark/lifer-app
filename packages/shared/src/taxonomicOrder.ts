// Field-guide order: related species together, as in eBird and printed guides. The API sorts
// species by it (apps/api/src/lib/taxonomicOrder.ts) and the web orders group headings by it, so
// both read the same.

// The groups as a field guide shelf would have them.
export const TAXON_CLASS_SEQUENCE = [
  "aves",
  "mammalia",
  "squamata",
  "testudines",
  "amphibia",
  "actinopterygii",
  "cephalopoda",
  "nudibranchs",
  "marine_mollusks",
  "crustacea",
  "echinodermata",
  "corals",
  "jellies_and_anemones",
  "sponges_tunicates_other",
];

// Bird orders in Clements (eBird) sequence.
export const BIRD_ORDER_SEQUENCE = [
  "Struthioniformes",
  "Rheiformes",
  "Apterygiformes",
  "Casuariiformes",
  "Tinamiformes",
  "Galliformes",
  "Anseriformes",
  "Phoenicopteriformes",
  "Podicipediformes",
  "Columbiformes",
  "Mesitornithiformes",
  "Pterocliformes",
  "Pteroclidiformes",
  "Otidiformes",
  "Musophagiformes",
  "Cuculiformes",
  // Nightjars and their allies, where the catalog splits them into orders of their own.
  "Steatornithiformes",
  "Nyctibiiformes",
  "Caprimulgiformes",
  "Aegotheliformes",
  "Apodiformes",
  "Opisthocomiformes",
  "Gruiformes",
  "Charadriiformes",
  "Eurypygiformes",
  "Phaethontiformes",
  "Gaviiformes",
  "Sphenisciformes",
  "Procellariiformes",
  "Ciconiiformes",
  "Suliformes",
  "Pelecaniformes",
  "Cathartiformes",
  "Accipitriformes",
  "Strigiformes",
  "Coliiformes",
  "Leptosomiformes",
  "Trogoniformes",
  "Bucerotiformes",
  "Coraciiformes",
  "Galbuliformes",
  "Piciformes",
  "Cariamiformes",
  "Falconiformes",
  "Psittaciformes",
  "Passeriformes",
];

interface Classified {
  taxonClass?: string | null;
  taxonOrder?: string | null;
  family?: string | null;
}

const position = (list: string[], value: string | null | undefined) => {
  const i = value ? list.indexOf(value) : -1;
  return i < 0 ? list.length : i;
};

/** Compares two species by field-guide order: group, then (birds) Clements order sequence, then
 *  order and family by name, unknowns last. The species' own published sequence isn't here. */
export function compareFieldGuideOrder(a: Classified, b: Classified): number {
  return (
    position(TAXON_CLASS_SEQUENCE, a.taxonClass) - position(TAXON_CLASS_SEQUENCE, b.taxonClass) ||
    position(BIRD_ORDER_SEQUENCE, a.taxonOrder) - position(BIRD_ORDER_SEQUENCE, b.taxonOrder) ||
    (a.taxonOrder ?? "\uffff").localeCompare(b.taxonOrder ?? "\uffff") ||
    (a.family ?? "\uffff").localeCompare(b.family ?? "\uffff")
  );
}
