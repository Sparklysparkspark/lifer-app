// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StarRangePicker from "./StarRangePicker";

const none = { min: null, max: null, unrated: false };

describe("StarRangePicker", () => {
  it("two clicks make a range", () => {
    const onChange = vi.fn();
    const { rerender } = render(<StarRangePicker value={none} onChange={onChange} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "3 stars" }));
    expect(onChange).toHaveBeenLastCalledWith({ min: 3, max: 3, unrated: false });
    rerender(<StarRangePicker value={{ min: 3, max: 3, unrated: false }} onChange={onChange} />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "3 stars" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "5 stars" }));
    expect(onChange).toHaveBeenLastCalledWith({ min: 3, max: 5, unrated: false });
  });

  it("keyboard activation and arrows", () => {
    const onChange = vi.fn();
    render(<StarRangePicker value={none} onChange={onChange} />);
    const two = screen.getByRole("button", { name: "2 stars" });
    fireEvent.keyDown(two, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "3 stars" }));
    fireEvent.click(two, { detail: 0 });
    expect(onChange).toHaveBeenLastCalledWith({ min: 2, max: 2, unrated: false });
  });

  it("clear and unrated", () => {
    const onChange = vi.fn();
    render(<StarRangePicker value={{ min: 3, max: null, unrated: false }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "4 stars" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Clear rating" }));
    expect(onChange).toHaveBeenLastCalledWith(none);
    fireEvent.click(screen.getByRole("checkbox", { name: "Unrated" }));
    expect(onChange).toHaveBeenLastCalledWith({ min: null, max: null, unrated: true });
  });
});
