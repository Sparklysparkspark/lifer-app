import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ThemeProvider } from "./hooks/useTheme";
import App from "./App";
import { tauriInvoke } from "./lib/tauri";
import "./index.css";

// Inside Tauri, rebuild window.liferSetup from invoke() since no preload script survives the
// window navigating to the API origin. A no-op in a browser tab or the server deployment.
const invoke = tauriInvoke();
if (!window.liferSetup && invoke) {
  window.liferSetup = {
    choose: (config) => invoke("choose_setup", { config }) as ReturnType<NonNullable<Window["liferSetup"]>["choose"]>,
    getConfig: () => invoke("get_config") as ReturnType<NonNullable<Window["liferSetup"]>["getConfig"]>,
    currentNetworkInfo: () => invoke("current_network_info") as ReturnType<NonNullable<Window["liferSetup"]>["currentNetworkInfo"]>,
    testEndpoint: (url) => invoke("test_endpoint", { url }) as ReturnType<NonNullable<Window["liferSetup"]>["testEndpoint"]>,
    testLogin: (url, email, password) =>
      invoke("test_login", { url, email, password }) as ReturnType<NonNullable<Window["liferSetup"]>["testLogin"]>,
    setLocalDataDir: (dataDir) => invoke("set_local_data_dir", { dataDir }) as Promise<void>,
    platform: (window as unknown as { __LIFER_PLATFORM__?: string }).__LIFER_PLATFORM__ ?? "",
  };
}

// The frameless mac window's traffic lights float over the top-left. index.css's
// [data-mac-app] header.page-header rule clears space for them.
if (window.liferSetup?.platform === "darwin") {
  document.documentElement.setAttribute("data-mac-app", "");
}

// Tauri routes target="_blank" links through the shell plugin's "open", which the capabilities
// deliberately don't grant. Send external links through the permitted opener plugin instead.
if (invoke) {
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
