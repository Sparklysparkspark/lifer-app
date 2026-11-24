// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: vi.fn(), post: (...a: unknown[]) => post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const { default: CollectionSelectBar } = await import("./CollectionSelectBar");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

describe("CollectionSelectBar", () => {
  it("archives without asking first, and offers Undo", async () => {
    post.mockResolvedValue({ changedIds: ["a"] });
    const onChanged = vi.fn();
    render(
      <ToastContext.Provider value={toast}>
        <CollectionSelectBar
          selectedIds={new Set(["a", "b"])}
          totalCount={2}
          onSelectAll={vi.fn()}
          onDeselectAll={vi.fn()}
          onChanged={onChanged}
          onDone={vi.fn()}
        />
      </ToastContext.Provider>,
    );
    await act(async () => screen.getByRole("button", { name: "Archive" }).click());
    expect(post).toHaveBeenCalledWith("/collection/bulk", { action: "archive", speciesIds: ["a", "b"] });
    expect(onChanged).toHaveBeenCalledWith(["a"], "removed");
    const [, options] = toast.show.mock.lastCall!;
    expect(options.actions[0].label).toBe("Undo");
  });
});
