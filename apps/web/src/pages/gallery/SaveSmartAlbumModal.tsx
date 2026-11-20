import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import RenameModal from "../../components/RenameModal";
import { backStateFor } from "../../lib/backLabel";
import { useToast } from "../../hooks/useToast";
import { rulesFromQuery, useRulesSummary } from "./smartAlbumRules";
import type { GalleryQuery } from "./types";

// Names the Gallery's current search and filters and saves them as a smart album, then opens it.
export default function SaveSmartAlbumModal({ query, onClose }: { query: GalleryQuery; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const rules = rulesFromQuery(query);
  const summary = useRulesSummary(rules) ?? "";

  async function save(name: string) {
    const created = await api.post("/albums", { name, rules });
    toast.success(t("albums.smart.created"));
    navigate(`/albums/${created.id}`, { state: backStateFor(location, t) });
  }

  return (
    <RenameModal title={t("albums.smart.saveFromGallery")} initialName={summary} onCancel={onClose} onSave={save} />
  );
}
