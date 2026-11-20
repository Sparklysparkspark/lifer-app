// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";

const get = vi.fn(async () => ({ tags: [] }));
const post = vi.fn((..._a: unknown[]) => Promise.resolve({} as unknown));
const patch = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: () => get(), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a) },
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("./useToast", () => ({ useToast: () => toast }));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

const coordinates = vi.fn((_props: Record<string, unknown>) => null);
vi.mock("../components/CoordinatesModal", () => ({ default: (props: Record<string, unknown>) => coordinates(props) }));

const { usePhotoEdits } = await import("./usePhotoEdits");

type ToastAction = { label: string; onClick: () => void };
const lastActions = () => (toast.show.mock.calls.at(-1)?.[1] as { actions: ToastAction[] }).actions;

describe("usePhotoEdits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hides a photo, reloads, and offers an undo that unhides it", async () => {
    post.mockResolvedValue({ hidden: 1, covers: [] });
    const reload = vi.fn();
    const { result } = renderHook(() => usePhotoEdits({ reload }));
    await act(() => result.current.hide(["c1"]));
    expect(post).toHaveBeenCalledWith("/captures/hide", { captureIds: ["c1"] });
    expect(reload).toHaveBeenCalledTimes(1);
    const undo = lastActions().find((a) => a.label === "Undo")!;
    await act(async () => undo.onClick());
    expect(post).toHaveBeenLastCalledWith("/captures/unhide", { captureIds: ["c1"] });
  });

  it("moves a photo to another species with an undo back to the old one", async () => {
    const { result } = renderHook(() => usePhotoEdits({ reload: vi.fn() }));
    await act(() => result.current.reassign("c1", "old", { id: "new", common_name: "Jay" } as never));
    expect(patch).toHaveBeenCalledWith("/captures/c1/reassign", { speciesId: "new" });
    await act(async () =>
      lastActions()
        .find((a) => a.label === "Undo")!
        .onClick(),
    );
    expect(patch).toHaveBeenLastCalledWith("/captures/c1/reassign", { speciesId: "old" });
  });

  it("opens the coordinates dialog for the one photo, with Undo reloading", () => {
    const reload = vi.fn();
    const update = vi.fn();
    const { result } = renderHook(() => usePhotoEdits({ reload, update }));
    act(() => result.current.menuActions("c2").onSetLocation());
    const photos = [{ captureId: "c2", lat: "49.5", lon: "-123", regionId: null }];
    render(<>{result.current.dialog((id) => photos.find((p) => p.captureId === id))}</>);
    const props = coordinates.mock.calls.at(-1)![0] as {
      captureIds: string[];
      lat: number;
      suggestRegion: boolean;
      onSaved: (p: { lat: number; lon: number }, r: { id: string; name: string } | null) => void;
      onUndone: () => void;
    };
    expect(props.captureIds).toEqual(["c2"]);
    expect(props.lat).toBe(49.5);
    expect(props.suggestRegion).toBe(true);
    props.onSaved({ lat: 1, lon: 2 }, { id: "r1", name: "BC" });
    expect(update).toHaveBeenCalledWith("c2", { lat: 1, lon: 2, regionId: "r1" });
    props.onUndone();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
