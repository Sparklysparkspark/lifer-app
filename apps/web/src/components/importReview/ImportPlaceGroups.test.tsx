// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaceableRow, StagedPlace } from "./importGroups";

const get = vi.fn(async (path: string) =>
  path.includes("near=")
    ? {
        places: [
          { kind: "spot", id: "s1", name: "King Fisher Pond", locality: null, geoprivacy: "open", recognised: true },
        ],
      }
    : { places: [], nextOffset: null },
);
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (path: string) => get(path) },
}));
vi.mock("../../hooks/useRegions", () => ({
  useRegions: () => ({ regions: [{ id: "bc", name: "British Columbia" }], loading: false, error: null }),
}));

const { default: ImportPlaceGroups } = await import("./ImportPlaceGroups");

type Row = PlaceableRow & { label?: string };
const row = (key: string, time: string, gps?: Row["gps"]): Row => ({
  key,
  file: { lastModified: 0 },
  cameraTime: `2026-09-14T${time}:00`,
  gps: gps ?? null,
});

function setup(groups: Row[][]) {
  const onPlace = vi.fn<(keys: string[], place: StagedPlace | null) => void>();
  render(
    <ImportPlaceGroups
      groups={groups}
      activeKey={null}
      regionId={null}
      onPlace={onPlace}
      onLabel={vi.fn()}
      thumb={() => null}
      renderRow={(r) => <div key={r.key}>{r.key}</div>}
    />,
  );
  return { onPlace, sections: screen.getAllByRole("region") };
}

describe("ImportPlaceGroups", () => {
  it("shows each group's place chip: camera town, mixed, or Set place", () => {
    const gps = { lat: 53.9, lon: -122.7, regionId: "bc", town: "Prince George" };
    const { sections } = setup([
      [row("a", "07:00", gps), row("b", "07:05", gps)],
      [row("c", "10:00", gps), row("d", "10:05")],
      [row("e", "14:00")],
    ]);
    expect(within(sections[0]).getByRole("button", { name: "From the camera: near Prince George" })).toBeTruthy();
    expect(within(sections[1]).getByRole("button", { name: "1 from the camera, 1 without" })).toBeTruthy();
    expect(within(sections[2]).getByRole("button", { name: "Set place" })).toBeTruthy();
  });

  it("offers a saved place the GPS falls in, and the earlier group's place, without setting either", async () => {
    const gps = { lat: 53.9, lon: -122.7, regionId: "bc", town: null };
    const { onPlace, sections } = setup([[row("a", "07:00", gps)], [row("b", "10:00")]]);
    expect(within(sections[0]).getByRole("button", { name: "From the camera: British Columbia" })).toBeTruthy();
    fireEvent.click(await within(sections[0]).findByRole("button", { name: "Use it" }));
    expect(onPlace).toHaveBeenLastCalledWith(["a"], expect.objectContaining({ source: "spot", spotId: "s1" }));

    fireEvent.click(within(sections[1]).getByRole("button", { name: /^Same place as the / }));
    expect(onPlace).toHaveBeenLastCalledWith(
      ["b"],
      expect.objectContaining({ source: "session", regionId: "bc", point: { lat: 53.9, lon: -122.7 } }),
    );
  });

  it("starts groups after the fifth collapsed, with the place for every photo at the top", () => {
    const groups = Array.from({ length: 7 }, (_, i) => [row(`r${i}`, `${String(i * 2).padStart(2, "0")}:00`)]);
    setup(groups);
    expect(screen.queryByText("r4")).toBeTruthy();
    expect(screen.queryByText("r5")).toBeNull();
    expect(screen.getByRole("button", { name: "Place for all photos" })).toBeTruthy();
  });

  it("places only the photos without GPS in a mixed group, and the dialog counts those (A5)", () => {
    const gps = { lat: 53.9, lon: -122.7, regionId: "bc", town: "Prince George" };
    const { sections } = setup([[row("a", "07:00", gps), row("b", "07:05"), row("c", "07:06")]]);
    fireEvent.click(within(sections[0]).getByRole("button", { name: "1 from the camera, 2 without" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose a place" }));
    expect(screen.getByRole("dialog", { name: "Place for 2 photos" })).toBeTruthy();
  });

  it("an imported group offers no place changes, and a RAW with its JPG counts as one photo", () => {
    const done = (key: string, time: string) => ({ ...row(key, time), captureId: `c-${key}` });
    const jpg = { ...done("jpg", "07:00"), partnerKey: "raw", samePhotoAs: "raw.CR3" };
    const { sections } = setup([[done("raw", "07:00"), jpg]]);
    expect(within(sections[0]).getByText(/^1 photo,/)).toBeTruthy();
    expect(within(sections[0]).queryByRole("button", { name: "Set place" })).toBeNull();
    expect(within(sections[0]).getByText("Set place")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Place for all photos" })).toBeNull();
  });

  it("a collapsed group says how many photos its thumbnails leave out", () => {
    const groups = Array.from({ length: 6 }, (_, i) => [row(`r${i}`, `${String(i * 2).padStart(2, "0")}:00`)]);
    groups[5] = Array.from({ length: 7 }, (_, i) => row(`x${i}`, `12:0${i}`));
    render(
      <ImportPlaceGroups
        groups={groups}
        activeKey={null}
        regionId={null}
        onPlace={vi.fn()}
        onLabel={vi.fn()}
        thumb={() => "blob:x"}
        renderRow={(r) => <div key={r.key}>{r.key}</div>}
      />,
    );
    expect(screen.getByText("+3")).toBeTruthy();
  });
});
