import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { ignore } from "../lib/ignore";
import EmptyState from "./EmptyState";

function CrashFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      title={t("status.crashReport.crashed")}
      action={{ label: t("status.crashReport.retry"), onClick: onRetry }}
    />
  );
}

// Keeps a render error to the part that failed, and saves a local crash report the next launch
// offers to send (api crashReports/). `resetKey` clears the error, so navigating away recovers.
// The top-level one reloads on Try again, since nothing around it is left to fall back on.
export default class CrashBoundary extends Component<
  { children: ReactNode; resetKey?: string; reloadOnRetry?: boolean },
  { error: boolean; key?: string }
> {
  state = { error: false, key: this.props.resetKey };

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: boolean; key?: string }) {
    return props.resetKey === state.key ? null : { error: false, key: props.resetKey };
  }

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const err =
      error instanceof Error ? error : new Error(typeof error === "string" ? error : "A non-Error value was thrown");
    api
      .post("/crash-reports", {
        message: `${err.name}: ${err.message}`.slice(0, 20_000),
        stack: `${err.stack ?? ""}\n${info.componentStack ?? ""}`.slice(0, 200_000),
      })
      .catch(ignore("Couldn't save a crash report"));
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <CrashFallback
        onRetry={() => (this.props.reloadOnRetry ? window.location.reload() : this.setState({ error: false }))}
      />
    );
  }
}
