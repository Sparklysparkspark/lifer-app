import PasswordInput from "../../components/PasswordInput";
import Select from "../../components/Select";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import { formatDate } from "../../lib/format";
import { SHARE_EXPIRY_OPTIONS, type AlbumShares, type ShareExpiry } from "./useAlbumShares";

// The "Share…" panel: a form for a new link, then the album's existing links.
export default function AlbumSharePanel({ shares }: { shares: AlbumShares }) {
  const { form, now } = shares;
  return (
    <div className="border-b border-line bg-surface-muted px-6 py-4">
      <div className="max-w-lg space-y-3">
        <form onSubmit={shares.createShare} className="space-y-2 rounded-lg border border-line bg-surface p-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink">Password (optional)</label>
            <PasswordInput
              value={form.password}
              onChange={form.setPassword}
              placeholder="Leave blank for no password"
              autoComplete="new-password"
              className="w-full rounded-md border border-line px-3 py-1.5 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.allowDownload}
              onChange={(e) => form.setAllowDownload(e.target.checked)}
            />
            Allow visitors to download photos
          </label>
          <div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={form.showMetadata}
                onChange={(e) => form.setShowMetadata(e.target.checked)}
              />
              Show camera info (lens, settings)
            </label>
            <p className="mt-0.5 pl-6 text-xs text-muted">
              Location data is never included in a shared link, regardless of this setting.
            </p>
          </div>
          <Select
            label="Link expires"
            value={form.expiry}
            onChange={(e) => form.setExpiry(e.target.value as ShareExpiry)}
          >
            {SHARE_EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <FormMessage error={form.error} />
          <Button type="submit" size="sm" loading={form.creating}>
            {form.creating ? "Creating…" : "Create share link"}
          </Button>
        </form>

        {shares.shares && shares.shares.length > 0 && (
          <ul className="space-y-2">
            {shares.shares.map((share) => {
              const url = share.token ? `${window.location.origin}/share/${share.token}` : null;
              const expired = !!share.expiresAt && new Date(share.expiresAt).getTime() < now;
              return (
                <li
                  key={share.id}
                  className={`flex items-center justify-between gap-2 rounded-md border border-line bg-surface p-2 text-sm ${
                    share.revoked || expired ? "opacity-50" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate">
                      {share.revoked ? "Revoked" : expired ? "Expired" : (url ?? "This link can't be shown again. It still works.")}
                    </p>
                    <p className="text-xs text-muted">
                      {share.hasPassword ? "Password-protected" : "No password"}
                      {share.allowDownload ? " · Downloads allowed" : ""}
                      {share.expiresAt && !expired ? ` · Expires ${formatDate(share.expiresAt, "medium")}` : ""}
                    </p>
                  </div>
                  {!share.revoked && !expired && (
                    <div className="flex shrink-0 gap-2">
                      {url && (
                        <button
                          onClick={() => shares.copyShareUrl(url)}
                          className="rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-muted"
                        >
                          Copy
                        </button>
                      )}
                      <button
                        onClick={() => shares.revokeShare(share.id)}
                        className="rounded-md border border-line px-2 py-1 text-xs text-red-600 hover:bg-surface-muted dark:text-red-400"
                      >
                        Revoke
                      </button>
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
