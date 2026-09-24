// A small bordered/tinted alert, not just bare colored text, matching the tinted-badge visual
// language already used elsewhere (endemic/vagrant/invasive badges on SpeciesDetailPage), so an
// error reads as a real, noticeable status box instead of looking like an afterthought.
export default function FormMessage({ error, success = null }: { error: string | null; success?: string | null }) {
  if (error) {
    return (
      <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-400">
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-400">
        {success}
      </p>
    );
  }
  return null;
}
