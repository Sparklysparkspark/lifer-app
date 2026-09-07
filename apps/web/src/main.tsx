import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ThemeProvider } from "./hooks/useTheme";
import App from "./App";
import "./index.css";

// The Tauri desktop app has no single "preload script" that survives navigating this window
// to a different origin the way Electron's preload.js does (see apps/desktop/src/
// bridge.js's own comment) — so when this app is loaded INSIDE Tauri (window.__TAURI__ is
// injected globally by withGlobalTauri, on every origin including this one), reconstruct the
// exact same window.liferSetup shape here instead. Electron's real preload.js already sets
// this before this module ever runs, so this is a no-op there (and a no-op in a plain browser
// tab or the Docker/server deployment, where window.__TAURI__ never exists at all).
if (!window.liferSetup && (window as unknown as { __TAURI__?: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__) {
  const { invoke } = (window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__.core;
  window.liferSetup = {
    choose: (config) => invoke("choose_setup", { config }) as ReturnType<NonNullable<Window["liferSetup"]>["choose"]>,
    getConfig: () => invoke("get_config") as ReturnType<NonNullable<Window["liferSetup"]>["getConfig"]>,
    platform: (window as unknown as { __LIFER_PLATFORM__?: string }).__LIFER_PLATFORM__ ?? "",
  };
}

// Frameless-window mac traffic lights float over the top-left of the page — see index.css's
// [data-mac-app] header.page-header rule, which clears space for them on every page header.
if (window.liferSetup?.platform === "darwin") {
  document.documentElement.setAttribute("data-mac-app", "");
}

// Tauri's webview intercepts <a target="_blank"> (and window.open) links itself and routes
// them through tauri-plugin-shell's "open" command — a different plugin than tauri-plugin-opener
// (see SettingsPage.tsx's own openUrl usage for the iNaturalist connect flow), and one this app
// deliberately doesn't grant permission to (capabilities/default.json only allows shell:allow-execute
// /allow-spawn, scoped to the bundled node sidecar, not arbitrary URLs). Every plain external
// link across the app (Wikipedia credits, eBird import instructions, iNat edit links, etc.) hit
// that same "not allowed by ACL" rejection as a result. Intercepting clicks here and routing them
// through the already-permitted opener plugin fixes every such link at once, rather than
// special-casing each one the way the iNat connect flow already had to.
if ((window as unknown as { __TAURI__?: unknown }).__TAURI__) {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target !== "_blank") return;
      const href = anchor.href;
      if (!href.startsWith("http://") && !href.startsWith("https://")) return;
      event.preventDefault();
      import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href));
    },
    true,
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
