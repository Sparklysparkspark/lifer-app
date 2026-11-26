// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: () => new Promise(() => {}), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const { default: CollectionToolbar } = await import("./CollectionToolbar");
const { useCollectionUrlState } = await import("./useCollectionUrlState");
const { effectiveSeaZoneIds } = await import("./useSeaZoneFilter");
const { useCollectionDisplayPrefs } = await import("./useCollectionDisplayPrefs");

function Harness(props: { seaZones?: Array<{ id: string; name: string }>; regionName?: string }) {
  const url = useCollectionUrlState();
  const prefs = useCollectionDisplayPrefs();
  return (
    <CollectionToolbar
      url={url}
      prefs={prefs}
      startTransition={(fn) => fn()}
      availableTaxonFilters={[]}
      namingStyles={[]}
      availableYears={[2021]}
      hasGhost={false}
      hasLost={false}
      hasNeedsBetter={false}
      shownCount={0}
      totalLoaded={3}
      gridWidth={null}
      seaZones={props.seaZones}
      seaZonesRelevant={!!props.seaZones}
      selectedSeaZoneIds={effectiveSeaZoneIds(
        url.seaZonesChosen,
        url.seaZoneIds,
        props.seaZones ?? [],
        !!props.seaZones,
      )}
      regionName={props.regionName}
    />
  );
}

function renderAt(path: string, props: Parameters<typeof Harness>[0] = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness {...props} />
    </MemoryRouter>,
  );
}

describe("CollectionToolbar", () => {
  // Rule N7: every filter the badge counts has a control on screen to undo it.
  it("keeps each active filter's control on screen in a list it no longer applies to", () => {
    renderAt("/collection?ghostOnly=1&lostOnly=1&year=2019&likelyThisMonth=1&introduced=only&vagrant=hide");
    fireEvent.click(screen.getByRole("button", { name: "Filters (6)" }));
    expect((screen.getByRole("checkbox", { name: "Rarely recorded only" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Not seen in 25 years only" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: "Likely this month" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("combobox", { name: "Introduced" }) as HTMLSelectElement).value).toBe("only");
    expect((screen.getByRole("combobox", { name: "Vagrants" }) as HTMLSelectElement).value).toBe("hide");
    // 2019 isn't among this list's years, but it's still the one filtering.
    expect((screen.getByRole("combobox", { name: "Photographed in year" }) as HTMLSelectElement).value).toBe("2019");
  });

  it("hides the region-only and empty filters when they're off", () => {
    renderAt("/collection");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByRole("checkbox", { name: "Rarely recorded only" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Likely this month" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Vagrants" })).toBeNull();
  });

  it("counts only offered sea zones toward Select all and Include land", () => {
    const zones = [
      { id: "z1", name: "Strait" },
      { id: "z2", name: "Sound" },
    ];
    renderAt("/collection?region=r1&seaZones=gone", { seaZones: zones, regionName: "Freedonia" });
    const all = screen.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(false);
    expect(screen.queryByRole("checkbox", { name: "Include Freedonia's own species" })).toBeNull();
  });

  it("ticks every nearby zone when the user never chose, and none after they chose none", () => {
    const zones = [
      { id: "z1", name: "Strait" },
      { id: "z2", name: "Sound" },
    ];
    const { unmount } = renderAt("/collection?region=r1", { seaZones: zones });
    expect((screen.getByRole("checkbox", { name: "Strait" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement).checked).toBe(true);
    unmount();
    renderAt("/collection?region=r1&seaZones=none", { seaZones: zones });
    expect((screen.getByRole("checkbox", { name: "Strait" }) as HTMLInputElement).checked).toBe(false);
  });
});
