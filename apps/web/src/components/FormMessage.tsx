// A small tinted alert box for form errors and success messages.
// role="alert" for errors so screen readers announce them; success is polite.
export default function FormMessage({
  error = null,
  success = null,
  className = "",
}: {
  error?: string | null;
  success?: string | null;
  className?: string;
}) {
  if (error) {
    return (
      <p role="alert" className={`rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-400 ${className}`}>
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p role="status" className={`rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-400 ${className}`}>
        {success}
      </p>
    );
  }
  return null;
}
