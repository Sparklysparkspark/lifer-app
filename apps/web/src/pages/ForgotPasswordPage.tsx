import { useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";

const COMMANDS = [
  { label: "Docker", command: "docker compose exec api lifer-admin reset-password" },
  { label: "TrueNAS", intro: "Open Apps, select Lifer, click Shell on the lifer container, then run:", command: "lifer-admin reset-password" },
];

function CommandBlock({ command }: { command: string }) {
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
    <div className="flex items-center gap-2 rounded-md bg-surface-muted px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs text-ink">{command}</code>
      <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${command}`}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

// Recovery needs a shell on the server, which is what proves you run it. There is no email reset.
export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-ink">Forgot your password?</h1>
        <p className="text-sm text-muted">Run this in a shell on the server, then sign in with the new password.</p>
        {COMMANDS.map(({ label, intro, command }) => (
          <div key={label} className="space-y-2">
            <h2 className="text-sm font-medium text-ink">{label}</h2>
            {intro && <p className="text-sm text-muted">{intro}</p>}
            <CommandBlock command={command} />
          </div>
        ))}
        <Link to="/login" className="block text-center text-sm text-muted hover:underline">
          Back to login
        </Link>
      </div>
    </div>
  );
}
