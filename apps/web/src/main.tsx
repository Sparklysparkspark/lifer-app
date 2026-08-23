import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ThemeProvider } from "./hooks/useTheme";
import App from "./App";
import "./index.css";

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
