// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));
let mode = "desktop";
vi.mock("../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => mode }));

const { default: PairingConsentModal } = await import("./PairingConsentModal");

const ID = "a".repeat(64);
const consent = (over: object = {}) => ({
  id: ID,
  pluginId: "com.example.app",
  name: "Field Kit",
  scopes: ["userdata.read"],
  code: null,
  expiresAt: new Date().toISOString(),
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
  mode = "desktop";
});

describe("PairingConsentModal", () => {
  it("lists exactly the scopes asked for, and keeps Allow off for a moment", async () => {
    get.mockResolvedValue({ consents: [consent({ scopes: ["imports.write"], code: "482913" })] });
    render(<PairingConsentModal />);
    await screen.findByText("Allow Field Kit to connect to Lifer?");
    expect(screen.getByText("482913")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Import photos into your library"]);
    const allow = screen.getByRole("button", { name: "Allow" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(allow.hasAttribute("disabled")).toBe(false), { timeout: 2000 });
    fireEvent.click(allow);
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/plugins/v1/consents/${ID}`, { allow: true }));
  });

  it("says in plain words what the write scope allows, under the label Connected apps shows later", async () => {
    get.mockResolvedValue({ consents: [consent({ scopes: ["userdata.write"] })] });
    render(<PairingConsentModal />);
    await screen.findByText("Allow Field Kit to connect to Lifer?");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Rate and label photos, and choose featured photos" +
        "Rate your photos, mark them pick or reject, give them a colour label, choose each species' featured photo and its crop, and mark species that need a better photo. You can undo each change in Settings > Connected apps.",
    ]);
  });

  it("answers no when closed", async () => {
    get.mockResolvedValue({ consents: [consent()] });
    render(<PairingConsentModal />);
    await screen.findByText("Allow Field Kit to connect to Lifer?");
    // The dialog ignores answers until it has been up for ARM_MS, so keep pressing Escape until it counts.
    await waitFor(
      () => {
        fireEvent.keyDown(document, { key: "Escape" });
        expect(post).toHaveBeenCalledWith(`/plugins/v1/consents/${ID}`, { allow: false });
      },
      { timeout: 4000 },
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks a paired app's open-inside question in a small dialog, and Yes turns it on", async () => {
    get.mockResolvedValue({ consents: [consent({ kind: "hostPreference", scopes: [] })] });
    const pushed: unknown[] = [];
    const { onHostPreference } = await import("../lib/hostPreference");
    const off = onHostPreference("com.example.app", (p) => pushed.push(p));
    post.mockResolvedValue({ ok: true });
    render(<PairingConsentModal />);
    await screen.findByText("Field Kit: Open inside Lifer from now on?");
    expect(screen.queryByRole("listitem")).toBeNull();
    const yes = screen.getByRole("button", { name: "Yes" });
    expect(yes.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(yes.hasAttribute("disabled")).toBe(false), { timeout: 4000 });
    fireEvent.click(yes);
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/plugins/v1/consents/${ID}`, { allow: true }));
    await waitFor(() => expect(pushed).toEqual([{ openInHost: true }]));
    off();
  });

  it("Not now changes nothing", async () => {
    get.mockResolvedValue({ consents: [consent({ kind: "hostPreference", scopes: [] })] });
    render(<PairingConsentModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/plugins/v1/consents/${ID}`, { allow: false }));
  });

  it("doesn't ask a connected server", () => {
    mode = "server";
    render(<PairingConsentModal />);
    expect(get).not.toHaveBeenCalled();
  });
});
