import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ThemeProvider } from "./hooks/useTheme";
import App from "./App";
import "./index.css";

// The Tauri desktop app has no single "preload script" that survives navigating this window
// to a different origin the way Electron's preload.js does (see apps/desktop-tauri/src/
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
