// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { idleJobStatus } from "@lifer/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "./syncStatusText";

let status: SyncStatus | null = null;
vi.mock("../../lib/tauri", () => ({ tauriInvoke: () => async () => status }));

const { default: SyncSettings } = await import("./SyncSettings");

const make = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  linked: true,
  serverUrl: "http://nas:4000",
  unpushed: 0,
  waiting: { photos: 0, albums: 0, trips: 0 },
  serverChanged: false,
  derivative: "thumb",
  packs: idleJobStatus(),
  mirror: idleJobStatus(),
  push: idleJobStatus(),
  ...over,
});

afterEach(cleanup);

describe("SyncSettings", () => {
  it("shows photos and albums and trips as up to date when nothing waits", async () => {
    status = make();
    render(<SyncSettings onServer />);
    expect(await screen.findByText("Photos")).toBeTruthy();
    expect(screen.getByText("Albums and trips")).toBeTruthy();
    expect(screen.getAllByText("Up to date")).toHaveLength(2);
    expect(screen.queryByText(/It sends when the app connects/)).toBeNull();
  });

  it("counts 120,000 waiting changes with a plain reason", async () => {
    status = make({ unpushed: 120002, waiting: { photos: 120000, albums: 1, trips: 1 } });
    render(<SyncSettings onServer />);
    expect(await screen.findByText("120,000 changes waiting to sync")).toBeTruthy();
    expect(screen.getByText("2 changes waiting to sync")).toBeTruthy();
    expect(screen.getByText(/It sends when the app connects/)).toBeTruthy();
  });

  it("asks before starting over with a server that looks new", async () => {
    status = make({ serverChanged: true, unpushed: 5, waiting: { photos: 5, albums: 0, trips: 0 } });
    render(<SyncSettings onServer />);
    expect(await screen.findByRole("button", { name: "Send my library to it" })).toBeTruthy();
    expect(screen.getByText("Waiting for your answer below.")).toBeTruthy();
  });

  it("shows nothing when this app isn't linked", async () => {
    status = make({ linked: false });
    const { container } = render(<SyncSettings onServer />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});
