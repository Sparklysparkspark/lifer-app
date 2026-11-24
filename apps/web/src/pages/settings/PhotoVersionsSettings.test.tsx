// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/resource")>()),
  useApiRoute: () => ({ data: { names: ["Prints"], defaults: ["Prints"] }, reload: async () => {} }),
}));
const job = {
  status: null as unknown,
  start: vi.fn(async () => true),
};
vi.mock("../../hooks/useJobPoll", () => ({
  useJobPoll: () => ({
    status: job.status,
    loadError: null,
    actionError: null,
    starting: false,
    cancelling: false,
    start: job.start,
    cancel: vi.fn(),
    refresh: vi.fn(),
    clearActionError: vi.fn(),
  }),
}));
vi.mock("../../lib/pickFolderNative", () => ({ pickFolderNative: async () => "/photos/Moose" }));

const { default: PhotoVersionsSettings } = await import("./PhotoVersionsSettings");
afterEach(cleanup);

function Path() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}
const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <PhotoVersionsSettings />
      <Path />
    </MemoryRouter>,
  );

describe("PhotoVersionsSettings", () => {
  it("keeps a name already in the list in the field and says so", () => {
    renderIt();
    const field = screen.getByRole("textbox", { name: "Folder name to add" });
    fireEvent.change(field, { target: { value: "prints" } });
    expect(screen.getByText("Already in the list.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(field.closest("form")!);
    expect((field as HTMLInputElement).value).toBe("prints");
  });

  it("links to the review when a look found possible versions, and says nothing of 0", async () => {
    const { rerender } = renderIt();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose folder" })));
    job.status = { running: false, finishedAt: 1, result: { linked: 3, suggested: 0 } };
    rerender(
      <MemoryRouter initialEntries={["/settings"]}>
        <PhotoVersionsSettings />
        <Path />
      </MemoryRouter>,
    );
    expect(screen.getByText("Linked 3 versions.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    job.status = { running: false, finishedAt: 2, result: { linked: 3, suggested: 2 } };
    rerender(
      <MemoryRouter initialEntries={["/settings"]}>
        <PhotoVersionsSettings />
        <Path />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("path").textContent).toBe("/import");
  });
});
