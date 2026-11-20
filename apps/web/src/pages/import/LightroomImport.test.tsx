// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../../hooks/useJobPoll", () => ({ useJobPoll: () => ({ status: null }) }));

const { default: LightroomImport } = await import("./LightroomImport");
const { resetAccountCaches } = await import("../../lib/resource");

function mode(deploymentMode: "desktop" | "server") {
  get.mockImplementation((path: string) =>
    path === "/settings"
      ? Promise.resolve({ deploymentMode, dataDir: "/data", libraryRoots: [] })
      : Promise.resolve({ last: null }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountCaches();
});

describe("LightroomImport", () => {
  it("says a server can't read a catalogue", async () => {
    mode("server");
    render(
      <MemoryRouter>
        <LightroomImport />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/only available in the desktop app/)).toBeTruthy();
  });

  it("offers to choose a catalogue on the desktop, with no preview yet", async () => {
    mode("desktop");
    render(
      <MemoryRouter>
        <LightroomImport />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "Choose catalogue" })).toBeTruthy();
    expect(screen.queryByText("What to bring over")).toBeNull();
  });
});
