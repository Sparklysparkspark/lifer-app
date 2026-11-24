// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../pages/settings/useServerSetting", () => ({
  useServerSetting: () => ({ value: true, saving: false, error: null, save: vi.fn() }),
}));
vi.mock("../AddOtherTaxaModal", () => ({
  default: ({ initialQuery }: { initialQuery: string }) => <p>Searching for “{initialQuery}”</p>,
}));

const { default: InvertebrateHint } = await import("./InvertebrateHint");

describe("InvertebrateHint", () => {
  it("starts the iNaturalist search on what the photo looks like", async () => {
    render(<InvertebrateHint looksLike="a bee" regionId={null} onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Search iNaturalist" }));
    expect(await screen.findByText("Searching for “bee”")).toBeTruthy();
  });
});
