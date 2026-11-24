// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Pill from "./Pill";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const LONG = "Gulf of Saint Lawrence and the Estuary of the Saint Lawrence River, Quebec".repeat(4);

describe("Pill", () => {
  it("cuts a long name inside the pill instead of spilling over the next row", () => {
    render(
      <Pill active={false} onClick={() => {}}>
        {LONG}
      </Pill>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("max-w-full");
    expect(button.querySelector("span")!.className).toContain("truncate");
  });

  it("wraps instead when asked, for a list row's button", () => {
    render(
      <Pill active={false} onClick={() => {}} wrap>
        {LONG}
      </Pill>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("min-h-8");
    expect(button.querySelector("span")!.className).toContain("break-words");
  });

  it("shows the full name on hover only when it was cut", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
    render(
      <Pill active={false} onClick={() => {}}>
        {LONG}
      </Pill>,
    );
    fireEvent.pointerEnter(screen.getByRole("button"), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("tooltip").textContent).toContain(LONG);
  });
});
