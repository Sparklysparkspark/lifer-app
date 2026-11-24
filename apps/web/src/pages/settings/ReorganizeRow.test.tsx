// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleJobStatus } from "@lifer/shared";
import { ConfirmProvider } from "../../components/ConfirmProvider";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const { default: ReorganizeRow } = await import("./ReorganizeRow");

const running = { ...idleJobStatus(), running: true, phase: "moving", processed: 3, total: 10 };

beforeEach(() => {
  get.mockReset().mockResolvedValue(idleJobStatus());
  post.mockReset().mockResolvedValue({ started: true });
});
afterEach(cleanup);

function renderRow() {
  render(
    <ConfirmProvider>
      <ReorganizeRow description="Moves files." confirmMessage="This moves files." />
    </ConfirmProvider>,
  );
}

describe("ReorganizeRow", () => {
  it("picks up a run already in progress, with Cancel, after coming back to the page", async () => {
    get.mockResolvedValue(running);
    renderRow();
    expect(await screen.findByText("Reorganizing… (3 of 10)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reorganize" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/settings/reorganize-originals/cancel", {}));
  });

  it("starts in the background and reports the result with a plural", async () => {
    renderRow();
    fireEvent.click(await screen.findByRole("button", { name: "Reorganize" }));
    const dialog = await screen.findByRole("dialog");
    get.mockResolvedValueOnce(running).mockResolvedValue({
      ...idleJobStatus(),
      result: { moved: 1, total: 1, skipped: 0, failed: 0 },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reorganize" }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/settings/reorganize-originals?background=1", {}));
    expect(
      await screen.findByText("Moved 1 of 1 file (0 already in place, 0 failed).", {}, { timeout: 3000 }),
    ).toBeTruthy();
  });
});
