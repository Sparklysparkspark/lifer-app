import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "desktop" as "desktop" | "server" | null, tauri: true }));
vi.mock("../../hooks/useDeploymentMode", () => ({
  useDeploymentMode: () => state.mode,
  useIsTauri: () => state.tauri,
}));

import { RemoveAllDataSection } from "./StorageSettings";

// The command only answers the desktop app's own library pages (remove_data.rs), so the button is
// only offered there: never on a server's Settings, in a browser or inside the app.
describe("Remove all Lifer data", () => {
  beforeEach(() => {
    state.mode = "desktop";
    state.tauri = true;
  });

  it("is offered in the desktop app's own library", () => {
    expect(renderToStaticMarkup(<RemoveAllDataSection />)).toContain("Remove all Lifer data");
  });

  it("isn't offered on a server's pages, even inside the desktop app", () => {
    state.mode = "server";
    expect(renderToStaticMarkup(<RemoveAllDataSection />)).toBe("");
  });

  it("isn't offered in a browser", () => {
    state.tauri = false;
    expect(renderToStaticMarkup(<RemoveAllDataSection />)).toBe("");
  });
});
