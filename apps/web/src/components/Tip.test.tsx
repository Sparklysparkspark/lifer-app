// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const { default: Tip } = await import("./Tip");
const { resetAccountCaches } = await import("../lib/resource");

function serveSettings(tips: { tipsEnabled?: boolean; tipsSeen?: string[] }) {
  get.mockImplementation((path: string) =>
    path === "/settings"
      ? Promise.resolve({ tipsEnabled: true, tipsSeen: [], libraryRoots: [], ...tips })
      : new Promise(() => {}),
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset().mockResolvedValue({});
  resetAccountCaches();
});

describe("Tip", () => {
  it("shows a tip that hasn't been seen, and Got it records it", async () => {
    serveSettings({});
    render(<Tip id="import-keys" />);
    fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(post).toHaveBeenCalledWith("/settings/tips/seen", { id: "import-keys" });
  });

  it("stays hidden once seen, with tips off, or until the screen is usable", async () => {
    serveSettings({ tipsSeen: ["import-keys"] });
    const { unmount } = render(<Tip id="import-keys" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
    unmount();

    resetAccountCaches();
    serveSettings({ tipsEnabled: false });
    const second = render(<Tip id="import-keys" />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).toBeNull();
    second.unmount();

    resetAccountCaches();
    serveSettings({});
    render(<Tip id="import-keys" when={false} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("retires itself when the keys it teaches are used", async () => {
    serveSettings({});
    render(<Tip id="import-keys" />);
    await screen.findByRole("status");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(post).toHaveBeenCalledWith("/settings/tips/seen", { id: "import-keys" });
  });

  it("shows one tip at a time", async () => {
    serveSettings({});
    render(
      <>
        <Tip id="import-keys" />
        <Tip id="gallery-select" />
      </>,
    );
    await screen.findByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("lets a tip in the photo viewer take over, and gives the page's back after", async () => {
    serveSettings({});
    const { rerender } = render(<Tip id="gallery-select" />);
    await screen.findByText("select everything that matches");
    rerender(
      <>
        <Tip id="gallery-select" />
        <Tip id="viewer-keys" takeOver />
      </>,
    );
    expect(await screen.findByText("next photo")).toBeTruthy();
    expect(screen.queryByText("select everything that matches")).toBeNull();
    rerender(<Tip id="gallery-select" />);
    expect(await screen.findByText("select everything that matches")).toBeTruthy();
  });
});
