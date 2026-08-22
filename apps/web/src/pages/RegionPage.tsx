import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

// Region browsing lives on the main screen (CollectionPage, via ?region=), so drilling into
// a region never needs its own page navigation. This route stays only so old bookmarks/links
// to /region/:id keep working, by redirecting into the unified view.
export default function RegionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    navigate(id ? `/?region=${id}` : "/", { replace: true });
  }, [id, navigate]);

  return <div className="p-8 text-stone-500">Redirecting…</div>;
}
