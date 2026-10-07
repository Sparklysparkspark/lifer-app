// GBIF classes (as the country downloads spell them) whose species the catalog carries: every
// species name the pipeline matches against comes from one of these.
export const CATALOG_GBIF_CLASSES = new Set([
  "Aves", "Mammalia", "Reptilia", "Amphibia",
  "Myxini", "Petromyzonti", "Elasmobranchii", "Holocephali", "Coelacanthi", "Dipneusti", "Actinopterygii", "Teleostei",
  "Chondrostei", "Cladistii", "Holostei",
  "Anthozoa", "Hydrozoa", "Scyphozoa", "Cubozoa", "Staurozoa", "Echinoidea", "Asteroidea", "Ophiuroidea", "Holothuroidea",
  "Crinoidea", "Gastropoda", "Bivalvia", "Polyplacophora", "Scaphopoda", "Cephalopoda", "Malacostraca", "Copepoda",
  "Thecostraca", "Demospongiae", "Hexactinellida", "Calcarea", "Ascidiacea",
]);
