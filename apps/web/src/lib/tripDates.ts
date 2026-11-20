import { useTranslation } from "react-i18next";
import { formatDate, formatDateSpan } from "./format";

/** A trip's dates for display: "May 3 – 10, 2026", or "Since May 3, 2026" while it has no end. */
export function useTripDates() {
  const { t } = useTranslation();
  return (start: string, end: string | null) =>
    end ? formatDateSpan(start, end) : t("trips.dates.since", { date: formatDate(start) });
}
