import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import Button from "../components/Button";
import ManageListPage, { ManageList } from "../components/ManageListPage";
import Modal from "../components/Modal";
import SpeciesPicker from "../components/SpeciesPicker";
import { useToast } from "../hooks/useToast";
import { docsUrl } from "../lib/docs";
import { useSpeciesName } from "../lib/speciesName";
import { summarizeValues } from "./gallery/galleryHelpers";

interface SensitiveSpecies {
  id: string;
  commonName: string | null;
  scientificName: string;
  iucnStatus: string | null;
  reason: "iucn" | "ebird" | "added";
  removed: boolean;
  /** Where eBird lists it, when only in some areas ("England-GB"); empty for everywhere. */
  areas: string[];
}

// eBird writes an area as "Ontario-CA": the province, then its country's code.
const areaName = (area: string) => area.replace(/-([A-Z]{2})$/, ", $1");

const IUCN_LABEL: Record<string, string> = {
  VU: "iucn.category.vulnerable",
  EN: "iucn.category.endangered",
  CR: "iucn.category.criticallyEndangered",
};

// The species whose places stay off share links: threatened ones the user has photos of, plus
// any they added. Default ones marked not sensitive stay listed below, so they can be restored.
export default function SensitiveSpeciesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const [species, setSpecies] = useState<SensitiveSpecies[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [turningOn, setTurningOn] = useState(false);

  function fetchList() {
    Promise.all([api.get("/settings/sensitive-species/list"), api.get("/settings/metadata")])
      .then(([list, settings]) => {
        setSpecies(list.species);
        setEnabled(settings.sensitiveSpecies.enabled);
      })
      .catch(() => setLoadError(true));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchList();
  }
  useEffect(fetchList, []);

  async function mark(id: string, sensitive: boolean) {
    setBusy((prev) => new Set(prev).add(id));
    try {
      const path = apiPath("/settings/sensitive-species/{id}", { id });
      if (sensitive) await api.put(path);
      else await api.delete(path);
    } catch {
      toast.error(t("sensitiveSpecies.changeFailed"));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      load();
    }
  }

  async function turnOn() {
    setTurningOn(true);
    try {
      setEnabled((await api.put("/settings/sensitive-species", { enabled: true })).enabled);
    } catch {
      toast.error(t("sensitiveSpecies.changeFailed"));
    } finally {
      setTurningOn(false);
    }
  }

  // Hidden ones first, then the ones marked not sensitive; ManageList expects sections together.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = species ?? [];
    const hits = q
      ? all.filter((s) => (s.commonName ?? "").toLowerCase().includes(q) || s.scientificName.toLowerCase().includes(q))
      : all;
    return [...hits.filter((s) => !s.removed), ...hits.filter((s) => s.removed)];
  }, [species, search]);

  const reason = (s: SensitiveSpecies) =>
    s.reason === "added"
      ? t("sensitiveSpecies.reasons.added")
      : s.reason === "iucn" && s.iucnStatus && IUCN_LABEL[s.iucnStatus]
        ? t("sensitiveSpecies.reasons.iucn", { status: t(IUCN_LABEL[s.iucnStatus]) })
        : s.areas.length > 0
          ? t("sensitiveSpecies.reasons.ebirdAreas", { areas: summarizeValues(s.areas.map(areaName)) })
          : t("sensitiveSpecies.reasons.ebird");

  const title = t("sensitiveSpecies.title");
  return (
    <>
      <ManageListPage
        title={title}
        backLabel={t("nav.settings")}
        description={t("sensitiveSpecies.description")}
        help={[t("sensitiveSpecies.help.which"), t("sensitiveSpecies.help.effect")]}
        docsHref={docsUrl("/guides/albums-and-sharing#sensitive-species")}
        search={{ value: search, onChange: setSearch, placeholder: t("sensitiveSpecies.searchPlaceholder") }}
        actions={
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            {t("sensitiveSpecies.add")}
          </Button>
        }
        banner={
          !enabled && species ? (
            <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-muted px-page py-2">
              <p className="min-w-0 text-subheadline text-muted">{t("sensitiveSpecies.off")}</p>
              <Button variant="secondary" size="sm" className="shrink-0" onClick={turnOn} loading={turningOn}>
                {t("sensitiveSpecies.turnOn")}
              </Button>
            </div>
          ) : null
        }
        loading={!species && !loadError}
        error={loadError ? t("sensitiveSpecies.loadFailed") : null}
        onRetry={load}
        isEmpty={species?.length === 0}
        noMatch={species && species.length > 0 && shown.length === 0 ? t("sensitiveSpecies.noMatch", { search }) : null}
        empty={{
          icon: (
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
              <path d="M3 3l18 18" />
            </svg>
          ),
          title: t("sensitiveSpecies.empty.title"),
          description: t("sensitiveSpecies.empty.description"),
          action: { label: t("sensitiveSpecies.add"), onClick: () => setAdding(true) },
        }}
      >
        <ManageList
          label={title}
          rows={shown.map((s) => ({
            key: s.id,
            primary: speciesName(s),
            secondary: (
              <>
                <i>{s.scientificName}</i> · <span title={s.areas.map(areaName).join(" · ")}>{reason(s)}</span>
              </>
            ),
            to: `/species/${s.id}`,
            linkState: { backLabel: title },
            section: t(s.removed ? "sensitiveSpecies.sections.shown" : "sensitiveSpecies.sections.hidden"),
            menu: [
              {
                label: t(s.removed ? "sensitiveSpecies.restore" : "sensitiveSpecies.remove"),
                disabled: busy.has(s.id),
                onSelect: () => void mark(s.id, s.removed),
              },
            ],
          }))}
        />
      </ManageListPage>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={t("sensitiveSpecies.addTitle")}
        footer={
          <Button variant="secondary" onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </Button>
        }
      >
        <SpeciesPicker
          inline
          autoFocus
          onSelect={(r) => {
            setAdding(false);
            void mark(r.id, true);
          }}
        />
      </Modal>
    </>
  );
}
