import { useLocation, useNavigate } from "react-router-dom";

// Uses real browser back navigation instead of hardcoding `to="/"`, since CollectionPage
// keeps its filter state (group/sort/collectedFirst/taxon/show/seaZones) entirely in its own
// URL — navigating back restores that exact URL and everything encoded in it, rather than
// landing on a bare, unfiltered "/".
//
// location.key === "default" means there's no actual in-app history to go back to (opened
// via a fresh tab/bookmark/shared link) — falls back to `fallbackTo` in that case.
//
// `label` is the right text for a page with exactly one real entry point (e.g. Trip detail
// always comes from Trips). A page reachable from more than one place (SpeciesDetailPage: the
// main collection, a trip's species view, Archived species) instead gets its label from
// `location.state.backLabel`, set by whichever page navigated here — see SpeciesCard.tsx and
// ArchivedSpeciesPage.tsx's own Link `state` for where that's set.
export default function BackToCollectionLink({
  fallbackTo = "/",
  label = "Collection",
  className,
}: {
  fallbackTo?: string;
  label?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { backLabel?: string } | null;
  return (
    <button
      onClick={() => {
        if (location.key !== "default") navigate(-1);
        else navigate(fallbackTo);
      }}
      className={className}
    >
      ← {state?.backLabel ?? label}
    </button>
  );
}
