// Vitest setup: initialise i18n (English) before any test renders a component that calls
// useTranslation, as main.tsx does in the app.
import { afterEach } from "vitest";
import "./index";

// DOM tests opt in per file with `// @vitest-environment jsdom`; everything else stays on node.
if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);
}
