import type { ReactNode } from "react";
import FormMessage from "../../components/FormMessage";
import Switch from "../../components/Switch";
import type { ServerSetting } from "./useServerSetting";

export const inputClass = "w-full rounded-md border border-line px-3 py-2 text-sm";

// Settings layout: a titled group, then one panel of rows split by dividers. Each row has its
// label and a one-line description on the left and its control on the right; `children` is extra
// content under the row (a list to pick from, a result message).
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink">{title}</h2>
      <div className="divide-y divide-line rounded-panel border border-line bg-surface">{children}</div>
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
          <p className="text-sm text-ink">{label}</p>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </div>
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
