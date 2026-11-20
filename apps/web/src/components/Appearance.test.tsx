// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appearanceValues } from "../lib/appearance";

const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { post: (...a: unknown[]) => post(...a) },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));

const { AppearanceBadges, AppearanceModal, AppearanceSummary } = await import("./Appearance");

afterEach(() => vi.clearAllMocks());

const none = { lifeStage: null, sex: null, plumage: null, morph: null };
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

describe("AppearanceModal", () => {
  it("sends only what changed on one photo, trimmed, and closes at once", async () => {
    post.mockResolvedValue({ updated: 1 });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <AppearanceModal
        captureIds={["c1"]}
        initial={{ ...none, sex: "male" }}
        morphOptions={["Koi", "Marble", "Koi"]}
        onSaved={onSaved}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("Life stage"), { target: { value: "juvenile" } });
    fireEvent.change(screen.getByLabelText("Colour morph"), { target: { value: "  Koi  " } });
    save();
    expect(onClose).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith({ lifeStage: "juvenile", morph: "Koi" });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/captures/appearance", {
        captureIds: ["c1"],
        lifeStage: "juvenile",
        morph: "Koi",
      }),
    );
    // Used morphs are offered once each.
    expect([...document.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(
      expect.arrayContaining(["Koi", "Marble"]),
    );
  });

  it("clears a value with Not set, and puts it back when the save fails", async () => {
    post.mockRejectedValue(new Error("offline"));
    const onSaved = vi.fn();
    render(
      <AppearanceModal captureIds={["c1"]} initial={{ ...none, sex: "female" }} onSaved={onSaved} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Sex"), { target: { value: "" } });
    save();
    expect(onSaved).toHaveBeenNthCalledWith(1, { sex: null });
    await waitFor(() => expect(onSaved).toHaveBeenNthCalledWith(2, { sex: "female" }));
    expect(toast.error).toHaveBeenCalled();
  });

  it("leaves untouched fields alone on a selection", async () => {
    post.mockResolvedValue({ updated: 2 });
    render(<AppearanceModal captureIds={["a", "b"]} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Appearance of 2 photos")).toBeTruthy();
    expect((screen.getByLabelText("Life stage") as HTMLSelectElement).value).toBe("keep");
    fireEvent.change(screen.getByLabelText("Sex"), { target: { value: "unknown" } });
    save();
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/captures/appearance", { captureIds: ["a", "b"], sex: "unknown" }),
    );
  });

  it("sends nothing when nothing changed", () => {
    render(<AppearanceModal captureIds={["c1"]} initial={none} onSaved={vi.fn()} onClose={vi.fn()} />);
    save();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("AppearanceBadges and AppearanceSummary", () => {
  it("shows a badge for each value set, the full text of a long morph", () => {
    const long = "Extremely long aquarium strain name ".repeat(4).trim();
    render(<AppearanceBadges appearance={{ lifeStage: "juvenile", sex: "unknown", plumage: null, morph: long }} />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Juvenile", "Sex unknown", long]);
  });

  it("renders nothing when none is set", () => {
    const { container } = render(<AppearanceBadges appearance={none} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists distinct values in a natural order and caps a long list", () => {
    const items = [
      { ...none, lifeStage: "adult" as const, morph: "Zebra" },
      { ...none, lifeStage: "juvenile" as const, sex: "female" as const },
      ...Array.from({ length: 10 }, (_, i) => ({ ...none, morph: `Morph ${i}` })),
    ];
    expect(appearanceValues(items).slice(0, 4)).toEqual([
      { kind: "lifeStage", value: "juvenile" },
      { kind: "lifeStage", value: "adult" },
      { kind: "sex", value: "female" },
      { kind: "morph", value: "Morph 0" },
    ]);
    render(<AppearanceSummary items={items} />);
    expect(screen.getByText(/^Your photos show: Juvenile, Adult, Female, Morph 0/).textContent).toMatch(/and 6 more$/);
  });
});
