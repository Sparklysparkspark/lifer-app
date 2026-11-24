import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import { usePersistedState } from "../hooks/usePersistedState";
import { DEFAULT_RAW_FILES, rawFilterParams, type EditedRawFilter, type RawFilesFilter } from "../lib/photoListFilters";
import PageHeader from "../components/PageHeader";
import { useSidebarLayout } from "../components/AppSidebar";
import { docsUrl } from "../lib/docs";
import SegmentedControl from "../components/SegmentedControl";
import { Spinner } from "../components/LoadingScreen";
import EmptyState from "../components/EmptyState";
import Button from "../components/Button";
import { openExternal } from "../lib/openExternal";
import { useInatStatus } from "../hooks/useInatStatus";
import { useToast } from "../hooks/useToast";
import SightingsTab, { type Sighting } from "./inaturalist/SightingsTab";
import ObservationsTab, { type ObservationSummary } from "./inaturalist/ObservationsTab";
import { CLEAR_SELECTION_EVENT } from "./inaturalist/cardSelection";
import type { PossibleMatch } from "./inaturalist/ExistingObservations";
import { useExistingCheck } from "../hooks/useExistingCheck";
import { onAccountReset } from "../lib/resource";

const icon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);
const linkIcon = icon(
  "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
);

type Lists = {
  sightings: Sighting[];
  /** Before the RAW filters, so a filter never changes the tab's count. */
  sightingCount: number;
  ignoredCount: number;
  pending: ObservationSummary[];
  completed: ObservationSummary[];
  matches: PossibleMatch[];
};
type Tab = "import" | "pending" | "completed";
const TABS: Tab[] = ["import", "pending", "completed"];
const TAB_LABELS: Record<Tab, string> = {
  import: "inaturalist.tabs.import",
  pending: "inaturalist.tabs.pending",
  completed: "inaturalist.tabs.completed",
};

// While To finish is showing, Lifer asks iNaturalist again after this, doubling each time nothing
// changed, up to the maximum. The server also asks about each observation at most every 30 s.
const CHECK_START_MS = 30_000;
const CHECK_MAX_MS = 5 * 60_000;

// The last lists, so coming back draws them at once while they reload.
let lastLists: Lists | null = null;
onAccountReset(() => (lastLists = null));

// Sightings waiting to send, observations to finish on iNaturalist, and what's done.
export default function InaturalistPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const sidebarLayout = useSidebarLayout();
  const inat = useInatStatus();
  const [params, setParams] = useSearchParams();
  const [lists, setLists] = useState<Lists | null>(lastLists);
  const [loadError, setLoadError] = useState(false);
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  // The Gallery's RAW filters, kept like the Gallery keeps them; the server applies them to To send.
  const [rawFiles, setRawFiles] = usePersistedState<RawFilesFilter>("inatRawFiles", DEFAULT_RAW_FILES);
  const [editedRaw, setEditedRaw] = usePersistedState<EditedRawFilter>("inatEditedRaw", "any");
  const raw = { rawFiles, editedRaw, setRawFiles, setEditedRaw };

  const load = useCallback(
    () =>
      Promise.all([
        api.get(apiPath("/inaturalist/import", {}, rawFilterParams(rawFiles, editedRaw))),
        api.get("/inaturalist/pending"),
        api.get("/inaturalist/completed"),
        // Possible matches are extra: the page works without them.
        api.get("/inaturalist/matches").catch(() => ({ running: false, matches: [] })),
      ]).then(
        ([importRes, pendingRes, completedRes, matchesRes]) => {
          setLists(
            (lastLists = {
              sightings: importRes.clusters,
              sightingCount: importRes.totalCount,
              ignoredCount: importRes.ignoredCount,
              pending: pendingRes.observations,
              completed: completedRes.observations,
              matches: matchesRes.matches ?? [],
            }),
          );
          setLoadError(false);
        },
        () => setLoadError(true),
      ),
    [rawFiles, editedRaw],
  );
  const connected = inat?.connected === true;
  // Photos already on iNaturalist, found by the check (started here, or by Lifer after connecting).
  const existing = useExistingCheck(load, connected);
  // Unlink: an observation found on iNaturalist goes back to To send, its photos as they were.
  const unlink = async (observationId: string) => {
    try {
      const r = await api.post("/inaturalist/matches/unlink", { observationId });
      toast.success(
        r.kept > 0
          ? t("inaturalist.matches.unlinkedKept", { count: r.unlinked, kept: r.kept })
          : t("inaturalist.matches.unlinked", { count: r.unlinked }),
      );
    } catch {
      toast.error(t("inaturalist.existing.failed"));
    }
    await load();
  };
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  // Something unfinished comes first; otherwise the sightings still to send.
  const asked = params.get("tab");
  const tab: Tab = TABS.includes(asked as Tab)
    ? (asked as Tab)
    : lists && lists.pending.length > 0
      ? "pending"
      : "import";
  const setTab = (next: Tab) => setParams({ tab: next }, { replace: true });

  // Lifer asks iNaturalist itself whether each unfinished observation now has what it needed, and
  // moves the finished ones to Completed. Notes say what one still needs.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const hasPending = (lists?.pending.length ?? 0) > 0;
  const check = useCallback(
    async (observationIds?: string[]): Promise<number> => {
      if (inFlight.current) return 0;
      inFlight.current = true;
      setChecking(true);
      try {
        const result = await api.post("/inaturalist/pending/check", observationIds ? { observationIds } : {});
        setNotes(result.notes);
        if (result.completed > 0) {
          toast.success(t("inaturalist.pending.finished", { count: result.completed }));
          await load();
        }
        return result.completed;
      } catch {
        return 0;
      } finally {
        inFlight.current = false;
        setChecking(false);
      }
    },
    [load, t, toast],
  );

  // On open, and whenever the window comes back to the front (often from iNaturalist).
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (!hasPending) return;
    if (!checkedOnOpen.current) {
      checkedOnOpen.current = true;
      void check();
    }
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [hasPending, check]);

  // A gentle repeat while To finish is in view, backing off while nothing changes.
  useEffect(() => {
    if (tab !== "pending" || !hasPending) return;
    let delay = CHECK_START_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const finished = document.visibilityState === "visible" ? await check() : 0;
      delay = finished > 0 ? CHECK_START_MS : Math.min(delay * 2, CHECK_MAX_MS);
      timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => clearTimeout(timer);
  }, [tab, hasPending, check]);

  const counts: Record<Tab, number> = {
    import: lists?.sightingCount ?? 0,
    pending: lists?.pending.length ?? 0,
    completed: lists?.completed.length ?? 0,
  };

  let body: ReactNode;
  if (inat && !inat.connected) {
    body = (
      <EmptyState
        icon={linkIcon}
        title={t("inaturalist.notConnected.title")}
        description={t("inaturalist.notConnected.description")}
        action={{ label: t("inaturalist.notConnected.action"), onClick: () => navigate("/settings/integrations") }}
      />
    );
  } else if (loadError && !lists) {
    body = (
      <EmptyState
        title={t("inaturalist.loadFailed")}
        action={{ label: t("common.retry"), onClick: () => void load() }}
      />
    );
  } else if (!lists) {
    body = <Spinner />;
  } else if (tab === "import") {
    body = (
      <SightingsTab
        sightings={lists.sightings}
        ignoredCount={lists.ignoredCount}
        raw={raw}
        barSlot={barSlot}
        onChanged={load}
        matches={lists.matches}
        check={existing}
      />
    );
  } else if (tab === "pending") {
    body = (
      <ObservationsTab
        mode="pending"
        observations={lists.pending}
        notes={notes}
        checking={checking}
        onCheck={(ids) => void check(ids)}
        onUnlink={(id) => void unlink(id)}
        onChanged={load}
        barSlot={barSlot}
      />
    );
  } else {
    body = (
      <ObservationsTab
        mode="completed"
        observations={lists.completed}
        onUnlink={(id) => void unlink(id)}
        onChanged={load}
        barSlot={barSlot}
      />
    );
  }

  const username = inat?.username;
  return (
    <div className="flex min-h-full flex-1 flex-col bg-canvas">
      <PageHeader
        sticky
        topLevel={sidebarLayout}
        title={t("inaturalist.title")}
        backFallbackTo="/settings"
        backLabel={t("nav.settings")}
      >
        <p className={`max-w-2xl text-subheadline text-muted ${sidebarLayout ? "" : "mt-1"}`}>
          {t("inaturalist.intro")}{" "}
          <Button
            variant="link"
            size="sm"
            className="align-baseline text-link!"
            onClick={() => openExternal(docsUrl("/guides/inaturalist"))}
          >
            {t("manageList.learnMore")}
          </Button>
        </p>
        {connected && username && (
          <p className="mt-1 text-footnote text-muted">
            <Trans
              i18nKey="inaturalist.connectedAs"
              values={{ username }}
              components={{
                a: (
                  <Button
                    variant="link"
                    size="sm"
                    className="align-baseline text-link!"
                    onClick={() => openExternal(`https://www.inaturalist.org/people/${encodeURIComponent(username)}`)}
                  />
                ),
              }}
            />
          </p>
        )}
        {connected && (
          <div className="mt-3">
            <SegmentedControl
              value={tab}
              onChange={setTab}
              label={t("inaturalist.tabs.label")}
              options={TABS.map((value) => ({
                value,
                label: t(TAB_LABELS[value]),
                count: lists ? counts[value] : undefined,
              }))}
            />
          </div>
        )}
        <div ref={setBarSlot} />
      </PageHeader>
      <main
        className="flex-1 p-page"
        onClick={(e) => {
          // The page's empty background clears a card selection, like Finder.
          if (e.target === e.currentTarget) window.dispatchEvent(new Event(CLEAR_SELECTION_EVENT));
        }}
      >
        {body}
      </main>
    </div>
  );
}
