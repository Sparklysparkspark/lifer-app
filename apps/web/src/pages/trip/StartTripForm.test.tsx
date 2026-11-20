// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: vi.fn(), post: (...a: unknown[]) => post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../../components/RegionBrowser", () => ({ default: () => null }));

const { default: StartTripForm } = await import("./StartTripForm");
const { default: i18n } = await import("../../i18n");

function renderForm(onCancel = vi.fn()) {
  render(
    <MemoryRouter>
      <StartTripForm onCancel={onCancel} />
    </MemoryRouter>,
  );
  return onCancel;
}

describe("StartTripForm", () => {
  it("starts an Untitled Trip when the name is left empty, as the folder preview says", async () => {
    post.mockResolvedValue({ id: "t1", folder: "/library/Trips/Untitled Trip" });
    renderForm();
    const untitled = i18n.t("trips.create.untitled");
    expect(screen.getByText(i18n.t("trips.start.libraryFolder", { name: untitled }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("trips.start.submit") }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/trips/start", expect.objectContaining({ name: untitled, endDate: null })),
    );
  });

  it("ties the end date's hint to that field and cancels from the form", () => {
    const onCancel = renderForm();
    const end = screen.getByLabelText(i18n.t("trips.start.endDate"));
    expect(document.getElementById(end.getAttribute("aria-describedby")!)?.textContent).toBe(
      i18n.t("trips.start.endDateHint"),
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }));
    expect(onCancel).toHaveBeenCalled();
  });
});
