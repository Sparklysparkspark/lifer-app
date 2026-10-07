import type { ReactNode } from "react";
import FormMessage from "../../components/FormMessage";
import { docsUrl } from "../../lib/docs";
import type { ServerSetting } from "./useServerSetting";

export const inputClass = "w-full rounded-md border border-line px-3 py-2 text-sm";

// Anchor ids on the docs site's Settings reference page.
export function LearnMoreLink({ anchor }: { anchor: string }) {
  return (
    <a
      href={docsUrl(`/settings#${anchor}`)}
      target="_blank"
      rel="noreferrer"
      className="shrink-0 text-xs font-normal text-muted underline hover:text-ink"
    >
      Learn more
    </a>
  );
}

export function Card({
  title,
  description,
  learnMore,
  children,
}: {
  title: ReactNode;
  description: string;
  learnMore?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {learnMore && <LearnMoreLink anchor={learnMore} />}
      </div>
      {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

export function SettingToggleCard({
  title,
  description,
  learnMore,
  label,
  setting,
  checked,
  disabled = false,
  children,
}: {
  title: ReactNode;
  description: string;
  learnMore?: string;
  label: ReactNode;
  setting: ServerSetting;
  // Overrides the displayed state, e.g. forced off while a prerequisite is missing.
  checked?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  if (setting.value === null) return null;
  return (
    <Card title={title} description={description} learnMore={learnMore}>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={checked ?? setting.value}
          disabled={setting.saving || disabled}
          onChange={(e) => void setting.save(e.target.checked)}
          className="mt-0.5"
        />
        <span>{label}</span>
      </label>
      {children}
      <FormMessage error={setting.error} />
    </Card>
  );
}
