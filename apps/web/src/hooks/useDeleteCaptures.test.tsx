// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { post: (...a: unknown[]) => post(...a) },
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("./useToast", () => ({ useToast: () => toast }));
const photosDeleted = vi.fn();
vi.mock("../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/resource")>()),
  photosDeleted: () => photosDeleted(),
}));

const { useDeleteCaptures } = await import("./useDeleteCaptures");

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

function setup(selectMode = true, selected = ["a", "b"]) {
  const select = {
    selectMode,
    selectedIds: new Set(selected),
    setSelectedIds: vi.fn(),
    exit: vi.fn(),
  };
  const onDeleted = vi.fn();
  const reload = vi.fn();
  const { result } = renderHook(() => useDeleteCaptures({ select, onDeleted, reload }), { wrapper });
  return { result, select, onDeleted, reload };
}

beforeEach(() => {
  post.mockReset().mockResolvedValue({ ok: true });
  photosDeleted.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

describe("useDeleteCaptures", () => {
  it("trashes the selection, leaves select mode and offers Undo", async () => {
    const { result, select, onDeleted, reload } = setup();
    await act(() => result.current.deleteSelected());
    expect(post).toHaveBeenCalledWith("/captures/batch-delete", { captureIds: ["a", "b"], deleteRaw: false });
    expect(photosDeleted).toHaveBeenCalledTimes(1);
    expect(select.exit).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledWith(["a", "b"]);
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Moved 2 to Trash");

    const undo = options.actions.find((a: { label: string }) => a.label === "Undo");
    await act(async () => undo.onClick());
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/trash/a/restore", {});
    expect(post).toHaveBeenCalledWith("/trash/b/restore", {});
    expect(photosDeleted).toHaveBeenCalledTimes(2);
  });

  it("deletes one photo with its RAW and drops it from the selection", async () => {
    const { result, select, onDeleted } = setup(false, []);
    await act(() => result.current.deletePhoto("c", true));
    expect(post).toHaveBeenCalledWith("/captures/batch-delete", { captureIds: ["c"], deleteRaw: true });
    expect(select.setSelectedIds).toHaveBeenCalled();
    expect(select.exit).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledWith(["c"]);
    expect(toast.show.mock.calls[0][0]).toBe("Moved to Trash");
  });

  it("says so on failure and changes nothing", async () => {
    post.mockRejectedValueOnce(new TypeError("x is not a function"));
    const { result, select, onDeleted } = setup();
    await act(() => result.current.deleteSelected());
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete those photos");
    expect(photosDeleted).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(select.exit).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("ignores a second delete while the first is in flight", async () => {
    let finish!: () => void;
    post.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    const { result } = setup();
    await act(async () => {
      const first = result.current.deleteSelected();
      void result.current.deleteSelected();
      finish();
      await first;
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(photosDeleted).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside select mode", async () => {
    const { result } = setup(false);
    await act(() => result.current.deleteSelected());
    expect(post).not.toHaveBeenCalled();
  });
});
