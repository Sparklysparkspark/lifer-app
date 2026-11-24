// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem } from "@lifer/shared";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: () => new Promise(() => {}), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 0));

const { default: GroupedSpeciesGrid } = await import("./GroupedSpeciesGrid");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

afterEach(cleanup);

function manySpecies(count: number): CollectionItem[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        speciesId: `s${i}`,
        commonName: `Species ${i}`,
        scientificName: `Genus species${i}`,
        state: "unseen",
        taxonClass: "aves",
        family: `Family${Math.floor(i / 25)}`,
        isTarget: false,
        tier: null,
        localTier: null,
      }) as CollectionItem,
  );
}

function renderGrid(props: Partial<React.ComponentProps<typeof GroupedSpeciesGrid>> = {}) {
  return render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
        <MemoryRouter>
          <div data-tour="species">
            <GroupedSpeciesGrid
              items={manySpecies(3000)}
              groupBy="none"
              sortBy="taxonomic"
              collectedFirst={false}
              seenFirst={false}
              targetFirst={false}
              {...props}
            />
          </div>
        </MemoryRouter>
      </ConfirmContext.Provider>
    </ToastContext.Provider>,
  );
}

// Moves the page as if scrolled: the grid's top goes above the screen by `y`.
function scrollGridTo(container: HTMLElement, y: number) {
  const grid = container.querySelector<HTMLElement>("[data-tour] > div")!;
  grid.getBoundingClientRect = () => ({ top: -y, width: 1024, height: 0 }) as DOMRect;
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

const cards = (container: HTMLElement) => container.querySelectorAll<HTMLAnchorElement>("a[data-scroll-anchor]");

describe("GroupedSpeciesGrid windowing", () => {
  it("mounts only the cards near the screen out of 3,000", () => {
    const { container } = renderGrid();
    expect(cards(container).length).toBeGreaterThan(0);
    expect(cards(container).length).toBeLessThan(200);
    // The tour's target is the first card.
    expect(container.querySelector('[data-tour="species"] a[href^="/species/"]')?.getAttribute("href")).toBe(
      "/species/s0",
    );
    // Everything else is one spacer as tall as the rows it stands for.
    const spacers = container.querySelectorAll<HTMLElement>("[aria-hidden]");
    expect(spacers).toHaveLength(1);
    expect(parseFloat(spacers[0].style.height)).toBeGreaterThan(50_000);
  });

  it("gives photographed, seen and uncollected cards three distinct looks", () => {
    const items = manySpecies(3).map((it, i) => ({ ...it, state: (["collected", "seen", "unseen"] as const)[i] }));
    const { container } = renderGrid({ items });
    expect(container.querySelectorAll(".cover-seen")).toHaveLength(1);
    expect(container.querySelectorAll(".cover-uncollected")).toHaveLength(1);
    expect(container.querySelectorAll(".text-uncollected")).toHaveLength(1);
  });

  it("lays out rows as CSS auto-fill would", () => {
    const { container } = renderGrid();
    // 1024px wide (jsdom's window), 160px cards, 5px gap: 6 columns.
    const row = container.querySelector<HTMLElement>("[data-kind=row]")!;
    expect(row.style.gridTemplateColumns).toBe("repeat(6, minmax(0, 1fr))");
    expect(row.querySelectorAll("a[data-scroll-anchor]")).toHaveLength(6);
  });

  it("moves the window with the scroll position", () => {
    const { container } = renderGrid();
    scrollGridTo(container, 60_000);
    const ids = [...cards(container)].map((a) => Number(a.dataset.scrollAnchor!.slice(1)));
    expect(Math.min(...ids)).toBeGreaterThan(1000);
    expect(ids.length).toBeLessThan(200);
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(2);
  });

  it("ranks search matches inside each group and restores the sort order when the search clears", () => {
    const items = manySpecies(6).map((it, i) => ({ ...it, tier: i < 3 ? ("rare" as const) : ("common" as const) }));
    const ids = (container: HTMLElement) => [...cards(container)].map((a) => a.dataset.scrollAnchor);
    const ranks = new Map([
      ["s2", 4],
      ["s1", 1],
      ["s5", 4],
    ]);
    const { container, rerender } = renderGrid({ items, groupBy: "tier", searchRanks: ranks });
    expect(ids(container)).toEqual(["s2", "s1", "s0", "s5", "s3", "s4"]);
    rerender(
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
          <MemoryRouter>
            <div data-tour="species">
              <GroupedSpeciesGrid
                items={items}
                groupBy="tier"
                sortBy="taxonomic"
                collectedFirst={false}
                seenFirst={false}
                targetFirst={false}
                searchRanks={null}
              />
            </div>
          </MemoryRouter>
        </ConfirmContext.Provider>
      </ToastContext.Provider>,
    );
    expect(ids(container)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("keeps group headings in order with pinned groups first, while windowed", () => {
    const items = manySpecies(3000);
    items[2900].state = "collected";
    const { container } = renderGrid({ items, groupBy: "group", collectedFirst: true });
    const headings = [...container.querySelectorAll<HTMLElement>("[data-group-heading]")].map(
      (el) => el.dataset.groupHeading,
    );
    expect(headings[0]).toBe("__collected__");
    expect(headings.length).toBeGreaterThan(1);
    expect(cards(container).length).toBeLessThan(200);
    // The pinned copy of a species is repeated in its own group further down.
    expect(container.querySelector('[data-scroll-anchor="s2900"]')).not.toBeNull();
  });
});

describe("Archive group", () => {
  it("archives at once with Undo, removing only the species the server changed", async () => {
    const { api } = await import("../api/client");
    const post = vi.mocked(api.post);
    post.mockResolvedValue({ changedIds: ["s0", "s1"] });
    const onChanged = vi.fn();
    const { getByRole } = renderGrid({ items: manySpecies(3), groupBy: "group", onChanged });
    await act(async () => getByRole("button", { name: "Archive group" }).click());
    expect(post).toHaveBeenCalledWith("/collection/bulk", { action: "archive", speciesIds: ["s0", "s1", "s2"] });
    expect(onChanged).toHaveBeenCalledWith(["s0", "s1"], "removed");
    const [message, options] = toast.show.mock.lastCall!;
    expect(message).toBe("Archived 2 species.");
    await act(async () => options.actions[0].onClick());
    expect(post).toHaveBeenLastCalledWith("/collection/bulk", { action: "unarchive", speciesIds: ["s0", "s1"] });
    expect(onChanged).toHaveBeenLastCalledWith(["s0", "s1"], "reload");
  });
});
