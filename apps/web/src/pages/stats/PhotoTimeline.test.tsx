// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
// jsdom has no layout, so the chart gets a fixed size instead of measuring its box.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 800, height: 260 }),
}));

const { default: PhotoTimeline } = await import("./PhotoTimeline");

const months = [
  { month: "2019-11", taxonClass: "aves", count: 3 },
  { month: "2020-02", taxonClass: "amphibia", count: 10_000 },
  { month: "2021-01", taxonClass: "corals", count: 2 },
];

function renderTimeline(props: Partial<Parameters<typeof PhotoTimeline>[0]> = {}) {
  const onRangeChange = vi.fn();
  render(
    <MemoryRouter>
      <PhotoTimeline months={months} undated={1204} range={null} onRangeChange={onRangeChange} {...props} />
    </MemoryRouter>,
  );
  return onRangeChange;
}

afterEach(() => {
  cleanup();
  // The Months/Years switch is remembered; each test starts on Months.
  localStorage.clear();
  vi.useRealTimers();
});

describe("PhotoTimeline", () => {
  it("names each group with its count, says how many photos have no date, and has a table for screen readers", () => {
    renderTimeline();
    const legend = screen.getByRole("list");
    expect(within(legend).getByText("Birds").textContent).toBe("Birds 3");
    expect(within(legend).getByText(/Reptiles and amphibians/).textContent).toBe("Reptiles and amphibians 10,000");
    expect(within(legend).getByText(/Fish and sea life/).textContent).toBe("Fish and sea life 2");
    expect(screen.getByText("1,204 photos without a date")).toBeTruthy();
    // Only months with photos are rows; empty months between them are left out.
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByRole("rowheader", { name: "February 2020" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All dates" })).toBeNull();
  });

  it("moves an end of the range from the keyboard, then narrows the page once it settles", () => {
    vi.useFakeTimers();
    const onRangeChange = renderTimeline();
    const [startHandle] = screen.getAllByRole("slider");
    fireEvent.keyDown(startHandle, { key: "ArrowRight" });
    fireEvent.keyDown(startHandle, { key: "ArrowRight" });
    expect(onRangeChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(400));
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange).toHaveBeenCalledWith({ from: "2020-01", to: "2021-01" });
  });

  it("with a range picked, offers All dates and the map for those dates", () => {
    const onRangeChange = renderTimeline({ range: { from: "2020-02", to: "2020-02" } });
    // The line under the chart is the one announced.
    expect(screen.getAllByText("Feb 2020").some((el) => el.getAttribute("aria-live") === "polite")).toBe(true);
    expect(screen.getByRole("link", { name: "Show on map" }).getAttribute("href")).toBe(
      "/gallery?view=map&dateFrom=2020-02-01&dateTo=2020-02-29",
    );
    fireEvent.click(screen.getByRole("button", { name: "All dates" }));
    expect(onRangeChange).toHaveBeenCalledWith(null);
  });

  it("switches to one bar per year", () => {
    renderTimeline();
    fireEvent.click(screen.getByRole("button", { name: "Years" }));
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((r) => r.textContent),
    ).toEqual(["2019", "2020", "2021"]);
  });

  it("drags the picked window along the strip, and the handles jump to the ends with Home and End", () => {
    vi.useFakeTimers();
    const onRangeChange = renderTimeline();
    const [startHandle, endHandle] = screen.getAllByRole("slider");
    fireEvent.keyDown(endHandle, { key: "Home" });
    expect(endHandle.getAttribute("aria-valuetext")).toBe("November 2019");
    fireEvent.keyDown(endHandle, { key: "End" });
    fireEvent.keyDown(startHandle, { key: "End" });
    expect(startHandle.getAttribute("aria-valuetext")).toBe("January 2021");
    // jsdom has no layout: a 150px strip gives each of the 15 months 10px.
    const strip = startHandle.parentElement!;
    strip.getBoundingClientRect = () => ({ left: 0, width: 150 }) as DOMRect;
    strip.setPointerCapture = () => {};
    fireEvent.pointerDown(strip, { clientX: 35, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 65, pointerId: 1 });
    fireEvent.pointerUp(strip, { pointerId: 1 });
    act(() => void vi.advanceTimersByTime(400));
    expect(onRangeChange).toHaveBeenLastCalledWith({ from: "2020-02", to: "2020-05" });
  });

  it("puts a short span of photos on a year-long axis and names a lone month", () => {
    renderTimeline({ months: [{ month: "2026-09", taxonClass: "aves", count: 7 }] });
    expect(screen.getByText("Photos from Sep 2026")).toBeTruthy();
    const [startHandle] = screen.getAllByRole("slider");
    expect(startHandle.getAttribute("aria-valuetext")).toBe("October 2025");
  });

  it("with no dated photos, shows only the note", () => {
    renderTimeline({ months: [], undated: 1 });
    expect(screen.getByText("1 photo without a date")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Years" })).toBeNull();
  });
});
