/** Folds 52 weekly values into 12 monthly averages, by each week's middle day. The one place
 *  months are derived: region_species keeps only the weekly counts. Null when there are none. */
export function monthlyFromWeekly(weekly: number[] | null | undefined): number[] | null {
  if (!weekly || weekly.length === 0) return null;
  const sums = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  weekly.forEach((value, week) => {
    const midDay = week * 7 + 3; // day of the year, 0-based
    const month = Math.min(11, Math.floor(midDay / (365 / 12)));
    sums[month] += Number(value) || 0;
    counts[month]++;
  });
  return sums.map((sum, m) => (counts[m] ? sum / counts[m] : 0));
}
