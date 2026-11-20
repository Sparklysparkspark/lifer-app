// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal from "./Modal";
import FilterPopover from "./FilterPopover";

afterEach(cleanup);

describe("Modal", () => {
  it("defaults to the medium width and names itself from the title and description", () => {
    render(<Modal open onClose={() => {}} title="Add a saved spot" description="Pin a place you go back to." />);
    const dialog = screen.getByRole("dialog", { name: "Add a saved spot" });
    expect(dialog.className).toContain("sm:max-w-xl");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Pin a place you go back to.",
    );
  });

  it("submits from a footer button and from Enter in a field, and closes on Escape", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <Modal
        open
        onClose={onClose}
        title="Rename"
        onSubmit={onSubmit}
        footerStart={<button type="button">Reset</button>}
        footer={<button type="submit">Save</button>}
      >
        <input aria-label="Name" />
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.submit(screen.getByLabelText("Name"));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("peels Escape back one layer: a popover inside it first, then the dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Filters">
        <FilterPopover activeCount={0} label="More filters">
          <p>Popover body</p>
        </FilterPopover>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: /More filters/ }));
    expect(screen.getByText("Popover body")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Popover body")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
