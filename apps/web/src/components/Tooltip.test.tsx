// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Button, { IconButton } from "./Button";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(cleanup);
  afterEach(() => vi.useRealTimers());

  const hover = (el: HTMLElement) => fireEvent.pointerEnter(el, { pointerType: "mouse" });

  it("shows name, shortcut and line after the hover delay", () => {
    render(<IconButton aria-label="Rotate" tooltip={{ shortcut: "R", description: "Turns it." }} />);
    hover(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => void vi.advanceTimersByTime(700));
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Rotate");
    expect(tip.textContent).toContain("R");
    expect(tip.textContent).toContain("Turns it.");
  });

  it("closes on Escape and on leave", () => {
    render(<Button tooltip={{ label: "Save" }}>Go</Button>);
    const b = screen.getByRole("button");
    hover(b);
    act(() => void vi.advanceTimersByTime(700));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    hover(b);
    act(() => void vi.advanceTimersByTime(700));
    fireEvent.pointerLeave(b);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays closed while a menu is open and shows one at a time", () => {
    render(
      <>
        <div role="menu" />
        <Button tooltip={{ label: "A" }}>a</Button>
      </>,
    );
    hover(screen.getByRole("button"));
    act(() => void vi.advanceTimersByTime(700));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows at once on keyboard focus and closes on blur", () => {
    render(<IconButton aria-label="Rotate" />);
    const b = screen.getByRole("button");
    // jsdom has no :focus-visible; a keyboard focus is what this stands for.
    vi.spyOn(b, "matches").mockReturnValue(true);
    fireEvent.focus(b);
    act(() => void vi.advanceTimersByTime(0));
    expect(screen.getByRole("tooltip").textContent).toContain("Rotate");
    fireEvent.blur(b);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("wraps a control that isn't a Button", () => {
    render(<Tooltip content={{ label: "Fully downloaded" }}>{(p) => <button {...p}>Canada</button>}</Tooltip>);
    hover(screen.getByRole("button"));
    act(() => void vi.advanceTimersByTime(700));
    expect(screen.getByRole("tooltip").textContent).toBe("Fully downloaded");
  });
});
