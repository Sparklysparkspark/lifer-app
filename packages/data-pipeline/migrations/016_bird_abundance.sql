-- Real per-species population estimate (Callaghan et al. 2021, "Global abundance estimates
-- for 9,700 bird species," PNAS — CC-BY-4.0, verified on Zenodo doi.org/10.5281/zenodo.4723365
-- by hand). Combined with the range size already in this table, gives a real population
-- density signal: a wide-range but genuinely low-density species (e.g. Pileated Woodpecker)
-- is otherwise indistinguishable from an abundant one under a range-and-IUCN-only view.
ALTER TABLE species_traits ADD COLUMN population_estimate bigint NULL;
