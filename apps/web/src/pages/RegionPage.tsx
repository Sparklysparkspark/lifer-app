import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

// Region browsing lives on CollectionPage (?region=); this route only redirects old /region/:id links.
export default function RegionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    navigate(id ? `/?region=${id}` : "/", { replace: true });
  }, [id, navigate]);

  return <div className="p-8 text-muted">Redirecting…</div>;
}
