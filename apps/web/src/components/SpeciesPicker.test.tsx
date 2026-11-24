// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const put = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) },
}));
const save = vi.fn();
const setting = { value: false as boolean | null, saving: false, error: null, save };
vi.mock("../pages/settings/useServerSetting", () => ({ useServerSetting: () => setting }));
vi.mock("./AddOtherTaxaModal", () => ({
  default: ({ initialQuery }: { initialQuery: string }) => (
    <div role="dialog">iNaturalist search for {initialQuery}</div>
  ),
}));

const { default: SpeciesPicker } = await import("./SpeciesPicker");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function renderPicker(props: Partial<Parameters<typeof SpeciesPicker>[0]> = {}) {
  render(
    <MemoryRouter>
      <SpeciesPicker ariaLabel="Species" onSelect={() => {}} {...props} />
    </MemoryRouter>,
  );
  return screen.getByRole("combobox", { name: "Species" });
}

describe("SpeciesPicker", () => {
  it("turns on the iNaturalist search in place and opens it with what was typed", async () => {
    get.mockResolvedValue({ results: [] });
    save.mockResolvedValue(undefined);
    const field = renderPicker();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "jewel beetle" } });
    const turnOn = await screen.findByRole("button", { name: /Search iNaturalist for any species/ }, { timeout: 2000 });
    fireEvent.click(turnOn);
    await waitFor(() => expect(save).toHaveBeenCalledWith(true));
    expect((await screen.findByRole("dialog")).textContent).toContain("jewel beetle");
  });

  it("calls onCancel on Escape with nothing typed and no list open, and on leaving", async () => {
    get.mockResolvedValue({ results: [] });
    const onCancel = vi.fn();
    const field = renderPicker({ onCancel });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    fireEvent.blur(field);
    act(() => vi.advanceTimersByTime(200));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
