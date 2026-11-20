// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecentImportFolders from "./RecentImportFolders";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const mode = vi.hoisted(() => ({ value: "desktop" as string | null }));
vi.mock("../../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => mode.value }));

beforeEach(() => {
  mode.value = "desktop";
  get.mockResolvedValue({
    folders: [
      { path: "/Users/me/Pictures/Tofino 2026", lastImportedAt: "2026-11-01T00:00:00Z", photoCount: 100 },
      { path: "/Volumes/Card/DCIM", lastImportedAt: "2026-10-01T00:00:00Z", photoCount: 40 },
      { path: "/Users/me/Old", lastImportedAt: "2026-09-01T00:00:00Z", photoCount: 3 },
    ],
  });
  post.mockImplementation(async (_p: string, body: { path: string }) =>
    body.path === "/Volumes/Card/DCIM"
      ? { available: false, newCount: 0 }
      : { available: true, newCount: body.path.includes("Tofino") ? 200 : 0 },
  );
});

describe("RecentImportFolders", () => {
  it("counts each folder's new photos and imports one only on click", async () => {
    const onImport = vi.fn();
    render(<RecentImportFolders onImport={onImport} busyPath={null} />);
    const tofino = await screen.findByRole("button", { name: "Import new photos from Tofino 2026" });
    await waitFor(() => expect(tofino.textContent).toContain("200 new photos"));
    expect(screen.getByRole("button", { name: "Import new photos from Old" }).textContent).toContain("Nothing new");
    // A folder on an unplugged drive is left out.
    expect(screen.queryByRole("button", { name: /DCIM/ })).toBeNull();
    expect(onImport).not.toHaveBeenCalled();

    fireEvent.click(tofino);
    expect(onImport).toHaveBeenCalledWith("/Users/me/Pictures/Tofino 2026");
  });

  it("is desktop only", () => {
    mode.value = "server";
    const { container } = render(<RecentImportFolders onImport={() => {}} busyPath={null} />);
    expect(container.textContent).toBe("");
    expect(get).not.toHaveBeenCalled();
  });
});
