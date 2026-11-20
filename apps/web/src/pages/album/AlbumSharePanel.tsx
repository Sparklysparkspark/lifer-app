import { useTranslation } from "react-i18next";
import PasswordInput from "../../components/PasswordInput";
import Select from "../../components/Select";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import { formatDate } from "../../lib/format";
import { SHARE_EXPIRY_OPTIONS, type AlbumShares, type ShareExpiry } from "./useAlbumShares";
import Panel from "../../components/Panel";
import Checkbox from "../../components/Checkbox";
import Switch from "../../components/Switch";

// The "Share…" panel: a form for a new link, then the album's existing links.
export default function AlbumSharePanel({ shares, smart = false }: { shares: AlbumShares; smart?: boolean }) {
  const { t } = useTranslation();
  const { form, now } = shares;
  return (
    <div className="border-b border-line bg-surface-muted px-page py-4">
      <div className="max-w-lg space-y-3">
        {/* A smart album's link shows its live matches, so say so before it's shared. */}
        {smart && <p className="text-callout text-ink">{t("albums.smart.shareLive")}</p>}
        <Panel as="form" onSubmit={shares.createShare} className="space-y-2">
          <div>
            <label className="mb-1 block text-footnote font-medium text-ink">{t("albums.share.password")}</label>
            <PasswordInput
              value={form.password}
              onChange={form.setPassword}
              placeholder={t("albums.share.passwordPlaceholder")}
              autoComplete="new-password"
            />
          </div>
          <Checkbox checked={form.allowDownload} onChange={form.setAllowDownload}>
            {t("albums.share.allowDownload")}
          </Checkbox>
          <Checkbox
            checked={form.showMetadata}
            onChange={form.setShowMetadata}
            description={t("albums.share.noLocation")}
          >
            {t("albums.share.showMetadata")}
          </Checkbox>
          <Checkbox
            checked={form.showExactLocations}
            onChange={form.setShowExactLocations}
            description={t("albums.share.showLocationsDescription")}
          >
            {t("albums.share.showLocations")}
          </Checkbox>
          <Select
            label={t("albums.share.expires")}
            value={form.expiry}
            onChange={(e) => form.setExpiry(e.target.value as ShareExpiry)}
          >
            {SHARE_EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </Select>
          <FormMessage error={form.error} />
          <Button type="submit" loading={form.creating}>
            {form.creating ? t("common.creating") : t("albums.share.create")}
          </Button>
        </Panel>

        {shares.shares && shares.shares.length > 0 && (
          <ul className="divide-y divide-line border-t border-line">
            {shares.shares.map((share) => {
              const url = share.token ? `${window.location.origin}/share/${share.token}` : null;
              const expired = !!share.expiresAt && new Date(share.expiresAt).getTime() < now;
              return (
                <li
                  key={share.id}
                  className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2 text-callout ${
                    share.revoked || expired ? "opacity-50" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate">
                      {share.revoked
                        ? t("albums.share.revoked")
                        : expired
                          ? t("albums.share.expired")
                          : (url ?? t("albums.share.hiddenLink"))}
                    </p>
                    <p className="text-footnote text-muted">
                      {share.hasPassword ? t("albums.share.hasPassword") : t("albums.share.noPassword")}
                      {share.allowDownload ? t("albums.share.downloadsAllowed") : ""}
                      {share.expiresAt && !expired
                        ? t("albums.share.expiresOn", { date: formatDate(share.expiresAt, "medium") })
                        : ""}
                    </p>
                  </div>
                  {!share.revoked && !expired && (
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      <label className="flex items-center gap-1.5 text-footnote text-muted">
                        {t("albums.share.locationsToggle")}
                        <Switch
                          label={t("albums.share.showLocations")}
                          checked={share.showExactLocations}
                          onChange={(next) => void shares.setExactLocations(share.id, next)}
                        />
                      </label>
                      {url && (
                        <Button variant="secondary" size="sm" onClick={() => shares.copyShareUrl(url)}>
                          {t("albums.share.copy")}
                        </Button>
                      )}
                      <Button variant="danger" size="sm" onClick={() => shares.revokeShare(share.id)}>
                        {t("albums.share.revoke")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
