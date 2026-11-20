-- Months are derived from weekly_frequency (core/species/seasonality.ts), so the monthly copy goes.
ALTER TABLE region_species DROP COLUMN seasonality;
