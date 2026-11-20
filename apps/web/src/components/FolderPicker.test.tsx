// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", () => ({
  api: { get: (url: string) => get(url), post: (url: string, body: unknown) => post(url, body) },
}));
const { FolderBrowser } = await import("./FolderPicker");

afterEach(() => {
  cleanup();
  get.mockReset();
});

// Remembered state (docs/docs/contributing/remembered-state.md): the last export folder.
describe("FolderBrowser", () => {
  it("falls back to the top level when the remembered folder is gone or unplugged", async () => {
    get.mockImplementation((url: string) =>
      url.includes("path=")
        ? Promise.reject(new Error("gone"))
        : Promise.resolve({ path: "/home/me", parent: null, entries: [] }),
    );
    render(<FolderBrowser initialPath="/Volumes/unplugged/exports" onChoose={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText("/home/me")).toBeTruthy());
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("makes a new folder where it is and opens it, ready to use", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("Wildlife")
          ? { path: "/trips/Belize 2026/Wildlife", parent: "/trips/Belize 2026", entries: [] }
          : { path: "/trips/Belize 2026", parent: "/trips", entries: [] },
      ),
    );
    post.mockResolvedValue({ path: "/trips/Belize 2026/Wildlife" });
    const onChoose = vi.fn();
    render(<FolderBrowser initialPath="/trips/Belize 2026" onChoose={onChoose} onCancel={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name, like Wildlife" }), {
      target: { value: "Wildlife" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("/trips/Belize 2026/Wildlife")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/settings/browse-directory/new-folder", {
      parent: "/trips/Belize 2026",
      name: "Wildlife",
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onChoose).toHaveBeenCalledWith("/trips/Belize 2026/Wildlife");
  });

  it("returns exactly the folder it shows, even an empty one just opened", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("Wildlife")
          ? { path: "/Users/me/Desktop/Belize 2026/Wildlife", parent: "/Users/me/Desktop/Belize 2026", entries: [] }
          : {
              path: "/Users/me/Desktop/Belize 2026",
              parent: "/Users/me/Desktop",
              entries: [{ name: "Wildlife", path: "/Users/me/Desktop/Belize 2026/Wildlife" }],
            },
      ),
    );
    const onChoose = vi.fn();
    render(<FolderBrowser initialPath="/Users/me/Desktop/Belize 2026" onChoose={onChoose} onCancel={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Wildlife" }));
    await waitFor(() => expect(screen.getByText("/Users/me/Desktop/Belize 2026/Wildlife")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onChoose).toHaveBeenCalledWith("/Users/me/Desktop/Belize 2026/Wildlife");
  });
});
