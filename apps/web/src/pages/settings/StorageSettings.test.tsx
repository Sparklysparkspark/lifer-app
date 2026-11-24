// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));
vi.mock("../../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => "desktop", useIsTauri: () => false }));
vi.mock("../../lib/pickFolderNative", () => ({ pickFolderNative: () => Promise.resolve("/Volumes/Red 2TB") }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.reject(new Error("no confirm expected")) }));

const { StorageVolumesRows } = await import("./StorageSettings");

const drive = {
  id: "d1",
  label: "Red",
  mountPath: "/Volumes/Red",
  connected: true,
  isDefault: true,
  lastSeenAt: "2026-11-01T00:00:00Z",
  managedByEnv: false,
};

beforeEach(() => {
  get.mockReset().mockResolvedValue({ volumes: [drive] });
  post
    .mockReset()
    .mockResolvedValue({ id: "d2", label: "Red", mountPath: "/Volumes/Red", connected: true, readopted: 0 });
  put.mockReset().mockResolvedValue({ ok: true });
  del.mockReset().mockResolvedValue({ ok: true });
  toast.show.mockReset();
});
afterEach(cleanup);

describe("Storage drives", () => {
  it("keeps drive actions in one menu and removes at once with Undo, keeping it the default", async () => {
    render(<StorageVolumesRows />);
    fireEvent.click(await screen.findByRole("button", { name: "More options" }));
    expect(screen.queryByRole("menuitem", { name: "Make default" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    await vi.waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(del).toHaveBeenCalledWith("/storage-volumes/d1");
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Stopped tracking Red");
    options.actions[0].onClick();
    await vi.waitFor(() => expect(put).toHaveBeenCalledWith("/storage-volumes/d2/default", {}));
    expect(post).toHaveBeenCalledWith("/storage-volumes", { path: "/Volumes/Red", label: "Red" });
  });

  it("names a new drive after its folder, so nothing has to be typed", async () => {
    get.mockResolvedValue({ volumes: [] });
    render(<StorageVolumesRows />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a drive" }));
    expect(((await screen.findByRole("textbox", { name: "Drive name" })) as HTMLInputElement).value).toBe("Red 2TB");
  });

  it("cancels a rename with Escape", async () => {
    render(<StorageVolumesRows />);
    fireEvent.click(await screen.findByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Drive name" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Drive name" })).toBeNull();
  });
});
