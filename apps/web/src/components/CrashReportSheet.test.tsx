// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const { default: CrashReportSheet } = await import("./CrashReportSheet");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const report = {
  app: "lifer",
  version: "1.0.0",
  kind: "server-exception",
  message: "Error: boom",
  stack: "at x.js:1:2",
};

function renderSheet() {
  get.mockResolvedValue({ reports: [{ id: "123", report }] });
  render(
    <ToastContext.Provider value={toast}>
      <CrashReportSheet />
    </ToastContext.Provider>,
  );
}

describe("CrashReportSheet", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows exactly what will be sent, note included, and sends only on the click", async () => {
    renderSheet();
    expect(await screen.findByText("Lifer quit unexpectedly.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " Importing a card " } });
    expect(screen.getByText(/"note": "Importing a card"/).textContent).toBe(
      JSON.stringify({ ...report, note: "Importing a card" }, null, 2),
    );
    expect(post).not.toHaveBeenCalled();

    post.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(screen.queryByText("Lifer quit unexpectedly.")).toBeNull();
    expect(post).toHaveBeenCalledWith("/crash-reports/send", { ids: ["123"], note: "Importing a card" });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("offers Save report when sending fails", async () => {
    renderSheet();
    post.mockRejectedValue(new Error("offline"));
    fireEvent.click(await screen.findByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        "Couldn't send. Try again later.",
        expect.objectContaining({ tone: "error" }),
      ),
    );
    expect(toast.show.mock.calls[0][1].actions[0].label).toBe("Save report");
  });

  it("deletes the report on Don't send", async () => {
    renderSheet();
    post.mockResolvedValue({ ok: true });
    fireEvent.click(await screen.findByRole("button", { name: "Don't send" }));
    expect(post).toHaveBeenCalledWith("/crash-reports/dismiss", { ids: ["123"] });
  });
});
