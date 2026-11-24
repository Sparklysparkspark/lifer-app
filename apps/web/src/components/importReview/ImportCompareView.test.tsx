// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { isMac } from "../../lib/platform";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRowBase } from "./useImportReview";
import { frameView } from "../../lib/compareZoom";

vi.mock("../../api/client", () => ({
  apiPath: (p: string) => p,
  api: {
    get: vi.fn(async () => ({
      photos: [
        { url: "/r1/display", credit: "Ann" },
        { url: "/r2/display", credit: null },
      ],
    })),
  },
}));
// The real picker needs a router and settings; a field and a pick button stand in.
vi.mock("../SpeciesPicker", () => ({
  default: ({ onSelect, placeholder }: { onSelect: (s: unknown) => void; placeholder: string }) => (
    <>
      <input aria-label="species search" placeholder={placeholder} />
      <button onClick={() => onSelect({ id: "typed", common_name: "Typed Wren", scientific_name: "Typus" })}>
        pick typed
      </button>
    </>
  ),
}));
// The real viewer needs a router and toasts; this one shows what it was given.
vi.mock("../Lightbox", () => ({
  default: ({ slides, index, onClose }: { slides: { url: string }[]; index: number; onClose: () => void }) => (
    <div data-testid="lightbox">
      {slides.length} photos, showing {slides[index].url}
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));
const { default: ImportCompareView } = await import("./ImportCompareView");
const { compareCandidates, nextToConfirm } = await import("./compareQueue");

const sp = (id: string, score = 0.5) => ({ id, common_name: `${id} bird`, scientific_name: id, score });
const row = (key: string, extra: Partial<ReviewRowBase> = {}): ReviewRowBase => ({
  key,
  speciesId: null,
  speciesLabel: null,
  suggestions: [sp(`${key}a`, 0.6), sp(`${key}b`, 0.3)],
  ...extra,
});
const rows = [row("p1"), row("p2", { speciesId: "x", speciesLabel: "X" }), row("p3"), row("p4")];

function setup(target = { key: "p1", group: null as string[] | null }) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const onNoAnimal = vi.fn();
  // Confirming names the photos, as the import page does.
  function Harness() {
    const [list, setList] = useState(rows);
    return (
      <ImportCompareView
        rows={list}
        target={target}
        regionId={null}
        photoUrl={(r) => `/${r.key}.jpg`}
        nameOf={(r) => `${r.key}.jpg`}
        onConfirm={(keys, s) => {
          onConfirm(keys, s);
          setList((prev) => prev.map((r) => (keys.includes(r.key) ? { ...r, speciesId: s.id } : r)));
        }}
        onNoAnimal={(keys) => {
          onNoAnimal(keys);
          setList((prev) =>
            prev.map((r) => (keys.includes(r.key) ? { ...r, notWildlife: { looksLike: "", marked: true } } : r)),
          );
        }}
        onClose={onClose}
      />
    );
  }
  render(<Harness />);
  return { onConfirm, onClose, onNoAnimal };
}
const press = (key: string, code?: string) => act(() => void fireEvent.keyDown(window, { key, code }));
const shown = () => screen.getByTestId("import-compare").querySelectorAll("figcaption")[1].textContent;

beforeEach(() => document.body.replaceChildren());

describe("ImportCompareView", () => {
  it("Skip moves to the next photo without confirming or marking anything", () => {
    const { onConfirm, onNoAnimal } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    expect(screen.getByText("Your photo: p3.jpg")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onNoAnimal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    // The last photo to do: nothing further to skip to.
    expect(screen.getByRole("button", { name: /^Skip/ }).hasAttribute("disabled")).toBe(true);
  });

  it("skips a photo with no animal in it, by button or Mod+Backspace, and moves on", () => {
    const { onNoAnimal, onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Not wildlife" }));
    expect(onNoAnimal).toHaveBeenCalledWith(["p1"]);
    expect(screen.getByText("Your photo: p3.jpg")).toBeTruthy();
    act(() => void fireEvent.keyDown(window, { key: "Backspace", metaKey: isMac, ctrlKey: !isMac }));
    expect(onNoAnimal).toHaveBeenLastCalledWith(["p3"]);
    expect(screen.getByText("Your photo: p4.jpg")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("opens a photo full screen on a click or Enter, and comes back to compare as it was", async () => {
    vi.useFakeTimers();
    try {
      setup({ key: "p3", group: null });
      await act(async () => {});
      const [left, right] = screen.getByTestId("import-compare").querySelectorAll<HTMLElement>("[data-zoom-pane]");
      fireEvent.click(left, { detail: 1 });
      act(() => void vi.advanceTimersByTime(300));
      expect(screen.getByTestId("lightbox").textContent).toContain("1 photos, showing /p3.jpg");
      // Its keys are the viewer's: Enter doesn't confirm in compare underneath.
      press("Enter");
      fireEvent.click(screen.getByRole("button", { name: "close viewer" }));
      expect(screen.queryByTestId("lightbox")).toBeNull();
      expect(screen.getByText("Your photo: p3.jpg")).toBeTruthy();
      right.focus();
      fireEvent.keyDown(right, { key: "Enter" });
      expect(screen.getByTestId("lightbox").textContent).toContain("2 photos, showing /r1/display");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws the reference arrows on the photo, and both captions at one fixed height", async () => {
    setup();
    await act(async () => {});
    const [leftFigure, rightFigure] = screen.getByTestId("import-compare").querySelectorAll("figure");
    const next = screen.getByRole("button", { name: "Next" });
    expect(rightFigure.querySelector("figcaption")?.contains(next)).toBe(false);
    expect(next.parentElement?.querySelector("[data-zoom-pane]")).toBeTruthy();
    expect(leftFigure.querySelector("figcaption")?.className).toContain("h-14");
    expect(rightFigure.querySelector("figcaption")?.className).toContain("h-14");
  });

  it("switches species with 1 to 5 and Not this, and pages the shown species' photos", async () => {
    setup();
    await act(async () => {});
    expect(shown()).toContain("p1a bird");
    expect(shown()).toContain("1 of 2");
    press("ArrowRight");
    expect(shown()).toContain("2 of 2");
    press("2", "Digit2");
    expect(shown()).toContain("p1b bird");
    // A new species starts on its first photo.
    await act(async () => {});
    expect(shown()).toContain("1 of 2");
    press("1", "Digit1");
    fireEvent.click(screen.getByRole("button", { name: "Not this" }));
    expect(shown()).toContain("p1b bird");
  });

  it("Enter confirms the shown species and brings up the next photo still to confirm", () => {
    const { onConfirm, onClose } = setup({ key: "p3", group: null });
    press("Enter");
    expect(onConfirm).toHaveBeenCalledWith(["p3"], expect.objectContaining({ id: "p3a" }));
    expect(screen.getByText("Your photo: p4.jpg")).toBeTruthy();
    expect(shown()).toContain("p4a bird");
    press("Enter");
    // Wraps past the confirmed p2 to p1.
    expect(screen.getByText("Your photo: p1.jpg")).toBeTruthy();
    press("Enter");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Up and Down move between the photos to confirm", () => {
    setup();
    press("ArrowDown");
    expect(screen.getByText("Your photo: p3.jpg")).toBeTruthy();
    press("ArrowUp");
    press("ArrowUp");
    expect(screen.getByText("Your photo: p1.jpg")).toBeTruthy();
  });

  it("confirms a set of ticked photos together", () => {
    const { onConfirm } = setup({ key: "p1", group: ["p1", "p3"] });
    expect(screen.getByRole("button", { name: "Confirm all 2" })).toBeTruthy();
    press("Enter");
    expect(onConfirm).toHaveBeenCalledWith(["p1", "p3"], expect.objectContaining({ id: "p1a" }));
    expect(screen.getByText("Your photo: p4.jpg")).toBeTruthy();
  });

  it("adds a typed species to compare against, and a letter starts the search", () => {
    setup();
    press("w");
    expect(document.activeElement).toBe(screen.getByLabelText("species search"));
    fireEvent.click(screen.getByRole("button", { name: "pick typed" }));
    expect(shown()).toContain("Typed Wren");
    // Picking turns the search back into a card, and the species joins the strip.
    expect(screen.queryByLabelText("species search")).toBeNull();
    expect(screen.getAllByText("Typed Wren").length).toBeGreaterThan(1);
  });

  it("the Search species card opens the search, and Esc turns it back into the card", () => {
    setup();
    const card = () => document.querySelector("[data-search-card]")!;
    expect(card().classList).toContain("w-32");
    fireEvent.click(screen.getByRole("button", { name: /Search species/ }));
    expect(document.activeElement).toBe(screen.getByLabelText("species search"));
    // As wide as the results popover while searching, back to a card's width after.
    expect(card().classList).toContain("w-56");
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByLabelText("species search")).toBeNull();
    expect(screen.getByRole("button", { name: /Search species/ })).toBeTruthy();
    expect(card().classList).toContain("w-32");
  });

  it("labels a searched-for species Your pick, never with a made-up match", () => {
    setup();
    press("w");
    fireEvent.click(screen.getByRole("button", { name: "pick typed" }));
    expect(shown()).toContain("Your pick");
    expect(shown()).not.toMatch(/%/);
    const card = screen.getAllByTitle(/^Typed Wren/).find((el) => el.tagName === "BUTTON")!;
    expect(card.textContent).toContain("Your pick");
  });

  it("looks for a photo of a species that has none, then says when there still isn't one", async () => {
    const { api } = await import("../../api/client");
    const get = vi.mocked(api.get);
    let lookup!: () => void;
    get.mockImplementation((async (path: string) =>
      path === "/species/{id}" ? new Promise<null>((done) => (lookup = () => done(null))) : { photos: [] }) as never);
    try {
      setup();
      expect(await screen.findByText("Looking for a photo...")).toBeTruthy();
      await act(async () => lookup());
      expect(await screen.findByText("No reference photo yet")).toBeTruthy();
      // Confirm still works without a photo.
      expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(false);
    } finally {
      get.mockReset();
      get.mockImplementation(async () => ({
        photos: [
          { url: "/r1/display", credit: "Ann" },
          { url: "/r2/display", credit: null },
        ],
      }));
    }
  });

  it("puts its title in a title-bar row of its own, clear of the macOS window controls", () => {
    setup();
    const layer = screen.getByTestId("import-compare");
    // The row comes first, above the toolbar, and is a window drag region.
    expect(layer.firstElementChild?.hasAttribute("data-window-title-bar")).toBe(true);
    expect(layer.firstElementChild?.getAttribute("data-tauri-drag-region")).toBe("");
    expect(layer.firstElementChild?.textContent).toBe("Compare");
    // The toolbar's own copy of the title is the one hidden on the mac.
    expect(layer.querySelector("header h2")?.classList).toContain("window-title-elsewhere");
    // The row shows only in the mac desktop window outside full screen, and takes the title.
    const css = readFileSync(join(__dirname, "../../index.css"), "utf8");
    expect(css).toMatch(/\.window-title-bar \{\s*display: none;/);
    expect(css).toMatch(
      /\[data-mac-app\]:not\(\[data-fullscreen\]\) \.window-title-bar \{\s*display: flex;\s*height: 52px;/,
    );
    expect(css).toMatch(/\[data-mac-app\]:not\(\[data-fullscreen\]\) \.window-title-elsewhere \{\s*display: none;/);
  });
});

describe("compare helpers", () => {
  it("finds the next photo to confirm, wrapping and skipping the ones just done", () => {
    expect(nextToConfirm(rows, "p1", ["p1"])).toBe("p3");
    expect(nextToConfirm(rows, "p4", ["p4"])).toBe("p1");
    expect(nextToConfirm(rows, "p1", ["p1", "p3", "p4"])).toBeNull();
  });

  it("shows a likely genus under the photo, and confirming still files the species shown", () => {
    const top = rows[0].suggestions[0];
    top.probably = { rank: "genus", name: "Myotis", taxonClass: "mammalia" };
    try {
      const { onConfirm } = setup();
      const caption = screen.getByTestId("import-compare").querySelectorAll("figcaption")[0];
      expect(caption.textContent).toContain("Probably a Myotis");
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
      expect(onConfirm).toHaveBeenCalledWith(["p1"], expect.objectContaining({ id: "p1a" }));
    } finally {
      delete top.probably;
    }
  });

  it("lists each species once, the photos' suggestions before typed ones", () => {
    const ids = compareCandidates(rows, ["p1", "p3"], [sp("p1a", 0), sp("t", 0)]).map((c) => c.id);
    expect(ids).toEqual(["p1a", "p1b", "p3a", "p3b", "t"]);
  });

  it("frames the subject box, keeping the photo covering the frame", () => {
    // A centred box a fifth of a square photo in a square frame: zoom 3, no pan.
    const centred = frameView({ x: 40, y: 40, w: 20, h: 20 }, 1);
    expect(centred.scale).toBeCloseTo(3);
    expect(Math.abs(centred.x) + Math.abs(centred.y)).toBe(0);
    // A box in the corner pans as far as the edge allows.
    const corner = frameView({ x: 0, y: 0, w: 20, h: 20 }, 1);
    expect([corner.scale, corner.x, corner.y].map((n) => +n.toFixed(6))).toEqual([3, 1, 1]);
    // A wide photo in a square frame covers half its height, so the same box is half as tall.
    expect(frameView({ x: 40, y: 40, w: 20, h: 20 }, 2).scale).toBeCloseTo(3);
    expect(frameView({ x: 0, y: 0, w: 100, h: 100 }, 1).scale).toBe(1);
  });
});

describe("Choose the animal", () => {
  const boxes = [
    { x: 10, y: 10, w: 20, h: 20 },
    { x: 60, y: 40, w: 30, h: 30 },
  ];
  function setupChooser() {
    let finish!: () => void;
    const identify = vi.fn((_row: ReviewRowBase, _box: unknown) => new Promise<void>((done) => (finish = done)));
    function Harness() {
      const [list, setList] = useState([row("p1", { subject: boxes[0], subjectBoxes: boxes }), row("p3")]);
      return (
        <ImportCompareView
          rows={list}
          target={{ key: "p1", group: null }}
          regionId={null}
          photoUrl={(r) => `/${r.key}.jpg`}
          nameOf={(r) => `${r.key}.jpg`}
          onConfirm={() => {}}
          onNoAnimal={() => {}}
          onClose={() => {}}
          identifyAnimal={async (r, box) => {
            await identify(r, box);
            setList((prev) =>
              prev.map((x) =>
                x.key === r.key
                  ? { ...x, chosenBox: box, suggestions: box ? [sp("chosen", 0.9)] : row("p1").suggestions }
                  : x,
              ),
            );
          }}
        />
      );
    }
    render(<Harness />);
    return { identify, finish: () => act(async () => finish()) };
  }
  const editorBox = () => screen.getByTestId("box-editor-box") as HTMLElement;

  it("numbers the detector's boxes, moves the box to one with its digit, and Enter matches it", async () => {
    const { identify, finish } = setupChooser();
    fireEvent.click(screen.getByRole("button", { name: "Choose the animal" }));
    // Starts on the detected subject, with every animal found numbered.
    expect(document.querySelectorAll("[data-shortcut]").length).toBe(2);
    expect(editorBox().style.left).toBe("10%");
    expect(screen.getByText("Drag a box around the animal, or press its number.")).toBeTruthy();
    press("2", "Digit2");
    expect(editorBox().style.left).toBe("60%");
    // A letter doesn't open the search while choosing.
    press("w");
    expect(screen.queryByLabelText("species search")).toBeNull();
    press("Enter");
    expect(identify).toHaveBeenCalledWith(expect.objectContaining({ key: "p1" }), { x: 60, y: 40, w: 30, h: 30 });
    // Never a dead spinner: it says what it's doing, and Confirm waits for the answer.
    expect(screen.getByText("Matching the animal you chose")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
    await finish();
    expect(screen.queryByText("Matching the animal you chose")).toBeNull();
    expect(shown()).toContain("chosen bird");
    expect(screen.getByTestId("chosen-animal")).toBeTruthy();
  });

  it("Reset goes back to the animal Lifer found, and Esc cancels choosing", async () => {
    const { identify, finish } = setupChooser();
    fireEvent.click(screen.getByRole("button", { name: "Choose the animal" }));
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByTestId("box-editor")).toBeNull();
    // Esc peeled back only the choosing, not compare itself.
    expect(screen.getByTestId("import-compare")).toBeTruthy();
    expect(identify).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Choose the animal" }));
    fireEvent.click(screen.getByRole("button", { name: /Identify this animal/ }));
    await finish();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(identify).toHaveBeenLastCalledWith(expect.objectContaining({ key: "p1" }), null);
    await finish();
    expect(shown()).toContain("p1a bird");
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("is offered only where the photo can be matched again", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Choose the animal" })).toBeNull();
  });

  it("shows a plain message when matching fails", async () => {
    let fail!: (e: Error) => void;
    function Harness() {
      return (
        <ImportCompareView
          rows={[row("p1")]}
          target={{ key: "p1", group: null }}
          regionId={null}
          photoUrl={(r) => `/${r.key}.jpg`}
          nameOf={(r) => r.key}
          onConfirm={() => {}}
          onNoAnimal={() => {}}
          onClose={() => {}}
          identifyAnimal={() => new Promise((_, reject) => (fail = reject))}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Choose the animal" }));
    // No detector boxes: the box starts in the middle.
    expect(editorBox().style.left).toBe("35%");
    press("Enter");
    await act(async () => fail(new Error("Download the species-matching model in Settings to match an animal.")));
    expect(screen.getByRole("alert").textContent).toContain("Download the species-matching model");
    expect(shown()).toContain("p1a bird");
  });
});
