import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import Panel from "../components/Panel";

const COMMANDS = [
  { label: "Docker", command: "docker compose exec api lifer-admin reset-password" },
  {
    label: "TrueNAS",
    introKey: "auth.forgot.truenasIntro",
    command: "lifer-admin reset-password",
  },
];

function CommandBlock({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be blocked on plain http; the command stays selectable.
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-control bg-surface-muted px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-footnote text-ink">{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        aria-label={t("auth.forgot.copyCommand", { command })}
      >
        {copied ? t("auth.forgot.copied") : t("auth.forgot.copy")}
      </Button>
    </div>
  );
}

// Recovery needs a shell on the server, which is what proves you run it. There is no email reset.
export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <Panel className="w-full max-w-sm space-y-4">
        <h1 className="text-title-2 font-semibold text-ink">{t("auth.forgot.title")}</h1>
        <p className="text-callout text-muted">{t("auth.forgot.intro")}</p>
        {COMMANDS.map(({ label, introKey, command }) => (
          <div key={label} className="space-y-2">
            <h2 className="text-callout font-semibold text-ink">{label}</h2>
            {introKey && <p className="text-callout text-muted">{t(introKey)}</p>}
            <CommandBlock command={command} />
          </div>
        ))}
        <Link to="/login" className="block text-center text-callout text-muted hover:underline">
          {t("auth.forgot.backToLogin")}
        </Link>
      </Panel>
    </div>
  );
}
