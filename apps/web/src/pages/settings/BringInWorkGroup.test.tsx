// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { post: (...a: unknown[]) => post(...a) },
}));
const plugins = vi.fn();
const startPlugin = vi.fn();
const offered = vi.fn();
const exported = vi.fn();
vi.mock("../../lib/plugins", () => ({
  usePlugins: () => plugins(),
  startPlugin: (...a: unknown[]) => startPlugin(...a),
  offeredImports: (...a: unknown[]) => offered(...a),
  exportOfferedImport: (...a: unknown[]) => exported(...a),
}));

const { default: BringInWorkGroup } = await import("./BringInWorkGroup");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const app = (capabilities: string[]) => ({ id: "com.example.app", name: "Example", approved: true, capabilities });
const show = () =>
  render(
    <ToastContext.Provider value={toast}>
      <BringInWorkGroup />
    </ToastContext.Provider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("BringInWorkGroup", () => {
  it("shows nothing for apps that don't offer imports", () => {
    plugins.mockReturnValue([app(["pickers"])]);
    show();
    expect(screen.queryByText("Show past work")).toBeNull();
  });

  it("lists past work and imports the exported folder in the background", async () => {
    plugins.mockReturnValue([app(["offersImports"])]);
    offered.mockResolvedValue([{ id: "w1", name: "Heron morning", date: null, fileCount: 1 }]);
    exported.mockResolvedValue("/tmp/heron");
    post.mockResolvedValue({});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Show past work" }));
    expect(await screen.findByText("Heron morning")).toBeTruthy();
    expect(screen.getByText("1 file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bring in" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/imports/v1/folders", { path: "/tmp/heron", mode: "in-place" }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("says so when the app has no past work", async () => {
    plugins.mockReturnValue([app(["offersImports"])]);
    offered.mockResolvedValue([]);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Show past work" }));
    expect(await screen.findByText("Example has no past work to bring in")).toBeTruthy();
  });
});
