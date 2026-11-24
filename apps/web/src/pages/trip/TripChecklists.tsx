import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import Menu, { MenuItem, MenuPanel } from "../../components/Menu";
import Panel from "../../components/Panel";
import Select from "../../components/Select";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/format";
import { openExternal } from "../../lib/openExternal";
import { pickFolderNative } from "../../lib/pickFolderNative";
import { useApiRoute } from "../../lib/resource";

// A clock a whole number of hours off is the common case (a camera left on home time).
const OFFSET_HOURS = Array.from({ length: 25 }, (_, i) => i - 12);

/** The trip's eBird checklists, with the photos Lifer suggests for each. Nothing shows until the
 *  user has imported their eBird data. Suggestions only become links once confirmed here. */
export default function TripChecklists({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const desktop = useDeploymentMode() === "desktop";
  const route = useApiRoute(apiPath("/trips/{id}/ebird-checklists", { id: tripId }));
  const [hours, setHours] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { openKey, setOpenKey, ref } = useDropdownMenu<string>();
  const checklists = route.data?.checklists ?? [];
  if (checklists.length === 0) return null;

  async function run(action: () => Promise<unknown>, done?: string) {
    setError(null);
    setBusy(true);
    try {
      await action();
      await route.reload();
      if (done) toast.success(done);
    } catch (err) {
      setError(errorMessage(err, t("trips.checklists.failed")));
    } finally {
      setBusy(false);
    }
  }

  const match = () =>
    run(async () => {
      const res = await api.post(apiPath("/trips/{id}/ebird-match", { id: tripId }), { offsetMinutes: hours * 60 });
      toast.info(t("trips.checklists.matched", { count: res.suggested }));
    });
  const confirmLinks = (subId: string) =>
    api.post(apiPath("/trips/{id}/ebird-checklists/{subId}/confirm", { id: tripId, subId }));
  const dismissLinks = (subId: string) =>
    api.post(apiPath("/trips/{id}/ebird-checklists/{subId}/dismiss", { id: tripId, subId }));

  async function gather(subId: string) {
    const folder = await pickFolderNative();
    if (!folder) {
      if (folder === undefined) toast.error(t("trips.checklists.noPicker"));
      return;
    }
    await run(async () => {
      const res = await api.post(apiPath("/ebird/checklists/{subId}/export", { subId }), { folder });
      toast.success(t("trips.checklists.gathered", { count: res.copied }));
    });
  }

  return (
    <section className="space-y-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-title-3 font-semibold text-ink">{t("trips.checklists.title")}</h2>
        <div className="flex items-center gap-2">
          <Select
            label={t("trips.checklists.clock")}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            disabled={busy}
          >
            {OFFSET_HOURS.map((h) => (
              <option key={h} value={h}>
                {h === 0
                  ? t("trips.checklists.clockLocal")
                  : h > 0
                    ? t("trips.checklists.clockBehind", { hours: h })
                    : t("trips.checklists.clockAhead", { hours: -h })}
              </option>
            ))}
          </Select>
          <Button variant="secondary" size="sm" onClick={() => void match()} loading={busy}>
            {t("trips.checklists.match")}
          </Button>
        </div>
      </div>
      <FormMessage error={error} />
      <Panel grouped>
        {checklists.map((c) => (
          <div key={c.subId} className="flex items-center justify-between gap-item px-panel py-3">
            <div className="min-w-0">
              <p className="break-words text-body text-ink">{c.location || c.subId}</p>
              <p className="text-subheadline text-muted">
                {[
                  formatDate(c.startedAt.slice(0, 10)),
                  c.hasTime ? c.startedAt.slice(11, 16) : null,
                  t("trips.checklists.species", { count: c.speciesCount }),
                  c.confirmed > 0 ? t("trips.checklists.confirmed", { count: c.confirmed }) : null,
                  c.suggested > 0 ? t("trips.checklists.suggested", { count: c.suggested }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {c.suggested > 0 && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => confirmLinks(c.subId), t("trips.checklists.confirmedToast", { count: c.suggested }))
                  }
                >
                  {t("trips.checklists.confirm", { count: c.suggested })}
                </Button>
              )}
              <Menu
                open={openKey === c.subId}
                onToggle={() => setOpenKey(openKey === c.subId ? null : c.subId)}
                menuRef={ref}
                className="relative shrink-0"
                trigger="plain"
              >
                <MenuPanel className="whitespace-nowrap">
                  <MenuItem
                    onSelect={() => {
                      setOpenKey(null);
                      openExternal(c.url);
                    }}
                  >
                    {t("trips.checklists.open")}
                  </MenuItem>
                  {desktop && c.confirmed > 0 && (
                    <MenuItem
                      onSelect={() => {
                        setOpenKey(null);
                        void gather(c.subId);
                      }}
                    >
                      {t("trips.checklists.gather")}
                    </MenuItem>
                  )}
                  {c.suggested > 0 && (
                    <MenuItem
                      onSelect={() => {
                        setOpenKey(null);
                        void run(() => dismissLinks(c.subId));
                      }}
                    >
                      {t("trips.checklists.dismiss")}
                    </MenuItem>
                  )}
                </MenuPanel>
              </Menu>
            </div>
          </div>
        ))}
      </Panel>
    </section>
  );
}
