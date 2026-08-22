import { useLocation, useNavigate } from "react-router-dom";

// Uses real browser back navigation instead of hardcoding `to="/"`, since CollectionPage
// keeps its filter state (group/sort/collectedFirst/taxon/show/seaZones) entirely in its own
// URL — navigating back restores that exact URL and everything encoded in it, rather than
// landing on a bare, unfiltered "/".
//
// location.key === "default" means there's no actual in-app history to go back to (opened
// via a fresh tab/bookmark/shared link) — falls back to `fallbackTo` in that case.
export default function BackToCollectionLink({
  fallbackTo = "/",
  className,
}: {
  fallbackTo?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button
      onClick={() => {
        if (location.key !== "default") navigate(-1);
        else navigate(fallbackTo);
      }}
      className={className}
    >
      ← Collection
    </button>
  );
}
