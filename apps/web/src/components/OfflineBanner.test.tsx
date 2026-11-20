// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import EmptyState from "./EmptyState";
import OfflineBanner, { OFFLINE_BANNER_DELAY_MS } from "./OfflineBanner";

let onLine = true;
beforeEach(() => {
  onLine = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => onLine);
  sessionStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function goOffline() {
  onLine = false;
  act(() => void window.dispatchEvent(new Event("offline")));
}

const message = () => i18n.t("status.offline.message");

describe("OfflineBanner", () => {
  it("shows only after being offline for a few seconds, and goes when back online", () => {
    render(<OfflineBanner />);
    goOffline();
    act(() => void vi.advanceTimersByTime(OFFLINE_BANNER_DELAY_MS - 1));
    expect(screen.queryByText(message())).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByText(message())).toBeTruthy();

    onLine = true;
    act(() => void window.dispatchEvent(new Event("online")));
    expect(screen.queryByText(message())).toBeNull();
  });

  it("never flashes for a blip", () => {
    render(<OfflineBanner />);
    goOffline();
    onLine = true;
    act(() => void window.dispatchEvent(new Event("online")));
    act(() => void vi.advanceTimersByTime(OFFLINE_BANNER_DELAY_MS * 2));
    expect(screen.queryByText(message())).toBeNull();
  });

  it("stays hidden for the session once dismissed", () => {
    render(<OfflineBanner />);
    goOffline();
    act(() => void vi.advanceTimersByTime(OFFLINE_BANNER_DELAY_MS));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("status.offline.dismiss") }));
    expect(screen.queryByText(message())).toBeNull();

    cleanup();
    render(<OfflineBanner />);
    act(() => void vi.advanceTimersByTime(OFFLINE_BANNER_DELAY_MS));
    expect(screen.queryByText(message())).toBeNull();
  });
});

describe("EmptyState with a load error", () => {
  it("says the connection's part instead of the page's description", () => {
    goOffline();
    render(
      <EmptyState
        title="Couldn't load your albums."
        description="Try again."
        error={new TypeError("Failed to fetch")}
      />,
    );
    expect(screen.getByText(i18n.t("errors.user.offline"))).toBeTruthy();
    expect(screen.queryByText("Try again.")).toBeNull();
  });

  it("leaves the offline line to the banner while it's up", () => {
    goOffline();
    render(
      <>
        <OfflineBanner />
        <EmptyState title="Couldn't load your albums." error={new TypeError("Failed to fetch")} />
      </>,
    );
    expect(screen.getByText(i18n.t("errors.user.offline"))).toBeTruthy();
    act(() => void vi.advanceTimersByTime(OFFLINE_BANNER_DELAY_MS));
    expect(screen.getByText(message())).toBeTruthy();
    expect(screen.queryByText(i18n.t("errors.user.offline"))).toBeNull();
  });

  it("keeps the page's own words when the server answered", () => {
    render(
      <EmptyState
        title="Couldn't load your albums."
        description="Something went wrong fetching your albums."
        error={Object.assign(new Error("Internal Server Error"), { status: 500 })}
      />,
    );
    expect(screen.getByText("Something went wrong fetching your albums.")).toBeTruthy();
  });
});
