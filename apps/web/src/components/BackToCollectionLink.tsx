import { useLocation, useNavigate } from "react-router-dom";

// Real history back, so the collection's URL-held filters survive; `fallbackTo` when there's no
// in-app history. The label can come from `location.state.backLabel`.
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
