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

export function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <Spinner />
    </div>
  );
}
