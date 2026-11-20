import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import FormMessage from "../../components/FormMessage";
import Panel from "../../components/Panel";
import Switch from "../../components/Switch";
import type { ServerSetting } from "./useServerSetting";

// Settings layout: a titled group, then one panel of rows split by dividers. Each row has its
// label and a one-line description on the left and its control on the right; `children` is extra
// content under the row (a list to pick from, a result message).
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-title-3 font-semibold text-ink">{title}</h2>
      <Panel grouped>{children}</Panel>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  control,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-panel py-3">
      <div className="flex items-center justify-between gap-item">
        <div className="min-w-0">
          <p className="text-body text-ink">{label}</p>
          {description && <p className="mt-0.5 text-subheadline text-muted">{description}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  );
}

/** A row that opens another page: the whole row is the link, with a chevron. Rows that act in
 *  place use a Button in SettingRow instead. */
export function SettingLinkRow({ label, description, to }: { label: ReactNode; description?: ReactNode; to: string }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between gap-item px-panel py-3 first:rounded-t-panel last:rounded-b-panel hover:bg-surface-muted"
    >
      <div className="min-w-0">
        <p className="text-body text-ink">{label}</p>
        {description && <p className="mt-0.5 text-subheadline text-muted">{description}</p>}
      </div>
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4 shrink-0 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </Link>
  );
}

/** A row whose control is a switch for one server setting. */
export function SettingSwitchRow({
  label,
  description,
  setting,
  checked,
  disabled = false,
  children,
}: {
  label: string;
  description?: ReactNode;
  setting: ServerSetting;
  // Overrides the displayed state, e.g. forced off while a prerequisite is missing.
  checked?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  if (setting.value === null) return null;
  return (
    <SettingRow
      label={label}
      description={description}
      control={
        <Switch
          label={label}
          checked={checked ?? setting.value}
          disabled={setting.saving || disabled}
          onChange={(next) => void setting.save(next)}
        />
      }
    >
      {(children || setting.error) && (
        <>
          {children}
          <FormMessage error={setting.error} />
        </>
      )}
    </SettingRow>
  );
}
