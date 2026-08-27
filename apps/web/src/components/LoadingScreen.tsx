import { Link } from "react-router-dom";

// A plain "Loading…" string dropped wherever a component happens to bail out early reads as
// unfinished, not intentional. This is the one loading state the whole app uses instead,
// scaled to where it's shown: LoadingScreen takes over the full viewport (nothing else has
// rendered yet — initial auth check, a species page before its data arrives); Spinner sits
// inside an already-rendered layout (a header/filters are up, just the content area beneath
// them is still loading).
export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

// If a page's own load call errors in a way it doesn't handle (or just hangs), this screen
// would otherwise be a dead end with no way out short of restarting the whole app — the
// back link is present as that escape hatch by default. "/" is always a safe destination even
// before auth resolves: RequireAuth redirects to /login on its own if there's no session yet.
// showBackLink={false} is only for a caller that already renders its own header (with its own
// back link) around this — SpeciesDetailPage's loading state does, so its two links would
// otherwise stack; ArchivedSpeciesPage's loading state has no header yet at that point, so it
// keeps this one.
export function LoadingScreen({ showBackLink = true }: { showBackLink?: boolean }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas">
      {showBackLink && (
        <Link to="/" className="back-link-corner absolute left-4 top-4 text-sm text-muted hover:underline">
          ← Back to collection
        </Link>
      )}
      <Spinner />
    </div>
  );
}
