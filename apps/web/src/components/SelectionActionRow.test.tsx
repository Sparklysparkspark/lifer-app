// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectionBar } from "./SelectionActionRow";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

function bar(count: number, total: number) {
  const onSelectAll = vi.fn();
  const onDeselectAll = vi.fn();
  render(
    <SelectionBar
      count={count}
      total={total}
      onSelectAll={onSelectAll}
      onDeselectAll={onDeselectAll}
      emptyText="Select photos to edit them"
      actions={[]}
    />,
  );
  return { onSelectAll, onDeselectAll };
}

describe("SelectionBar", () => {
  it("offers Select all and Deselect all while some are selected", () => {
    const { onSelectAll, onDeselectAll } = bar(3, 10);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(onSelectAll).toHaveBeenCalledOnce();
    expect(onDeselectAll).toHaveBeenCalledOnce();
  });

  it("shows only the one that would change something", () => {
    bar(0, 10);
    expect(screen.queryByRole("button", { name: "Deselect all" })).toBeNull();
    cleanup();
    bar(10, 10);
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
    expect(screen.getByRole("button", { name: "Deselect all" })).toBeTruthy();
  });

  it("has neither unless the page wires them, as before", () => {
    render(<SelectionBar count={2} emptyText="x" actions={[]} />);
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
  });
});
