// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));

const { PlaceStepProvider } = await import("./PlaceStep");
const { useSendToInat } = await import("../hooks/useSendToInat");

const PHOTO = "11111111-1111-4111-8111-111111111111";
const POND = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "King Fisher Pond",
  locality: "Prince George",
  geoprivacy: "obscured",
};
let far = { count: 0, km: 0 };

function SendButton() {
  const send = useSendToInat();
  return <button onClick={() => void send([PHOTO])}>Send it</button>;
}

beforeEach(() => {
  far = { count: 0, km: 0 };
  vi.stubGlobal("fetch", vi.fn());
  get.mockImplementation(async (url: string) =>
    url.startsWith("/places/locate")
      ? { places: [], nextOffset: null }
      : { running: false, result: { sent: 1, linked: 0, incomplete: 0, failed: 0, maybeOnInat: [] } },
  );
  post.mockImplementation(async (url: string) => {
    if (url === "/places/send-hints")
      return { withoutLocation: [PHOTO], point: { lat: 53.9, lon: -122.7 }, looksLike: POND, geoprivacy: null };
    if (url.endsWith("/far")) return far;
    if (url.endsWith("/apply")) return { ok: true, applied: 1 };
    return { ok: true };
  });
  render(
    <MemoryRouter>
      <PlaceStepProvider>
        <SendButton />
      </PlaceStepProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("Send it"));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const urls = () => post.mock.calls.map(([url]) => url as string);

describe("the place step before a Gallery send", () => {
  it("offers the recognised place, says how it will be sent, files the photos, then sends", async () => {
    await screen.findByText("Choose a place for 1 photo without a location");
    // While the list is open it leads with the offer, so the line above it steps aside.
    const field = screen.getByRole("combobox");
    fireEvent.focus(field);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use it" })).toBeNull());
    fireEvent.blur(field);
    fireEvent.click(await screen.findByRole("button", { name: "Use it" }));
    expect(screen.getByText("Will be sent obscured")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(urls()).toContain("/inaturalist/observations/batch"));
    const apply = post.mock.calls.find(([url]) => String(url).endsWith("/apply"))!;
    // Camera GPS is never moved without asking.
    expect(apply[1]).toMatchObject({ captureIds: [PHOTO], moveOwnPoints: false });
    expect(urls().indexOf("/inaturalist/observations/batch")).toBeGreaterThan(
      urls().findIndex((u) => u.endsWith("/apply")),
    );
  });

  it("asks inline when photos are far from the place, before filing anything", async () => {
    far = { count: 2, km: 40 };
    await screen.findByText("Choose a place for 1 photo without a location");
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/taken up to 40 km from here/);
    expect(urls().some((u) => u.endsWith("/apply"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "File here" }));
    await waitFor(() => expect(urls()).toContain("/inaturalist/observations/batch"));
  });

  it("still sends without a location, and Cancel sends nothing", async () => {
    await screen.findByText("Choose a place for 1 photo without a location");
    fireEvent.click(screen.getByRole("button", { name: "Send without a location" }));
    await waitFor(() => expect(urls()).toContain("/inaturalist/observations/batch"));
    expect(urls().some((u) => u.endsWith("/apply"))).toBe(false);

    post.mockClear();
    fireEvent.click(screen.getByText("Send it"));
    await screen.findByText("Choose a place for 1 photo without a location");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Choose a place for 1 photo without a location")).toBeNull());
    expect(urls()).toEqual(["/places/send-hints"]);
  });
});
