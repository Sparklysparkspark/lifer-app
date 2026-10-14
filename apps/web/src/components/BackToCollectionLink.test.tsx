// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import { useUrlParam } from "../hooks/useSearchParamsKeepingState";
import { backStateFor } from "../lib/backLabel";
import Lightbox from "./Lightbox";
import PageHeader from "./PageHeader";

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function Where() {
  const { pathname, search } = useLocation();
  return <p>at {pathname + search}</p>;
}

// A photo with its species link, as the Gallery, a trip and an album open it.
function Photo({ backLabel }: { backLabel?: string }) {
  return (
    <Lightbox
      slides={[{ url: "/a.jpg", caption: "Osprey", speciesId: "sp1" }]}
      index={0}
      onIndexChange={() => {}}
      onClose={() => {}}
      backLabel={backLabel}
    />
  );
}

function Gallery() {
  const [q, setQ] = useUrlParam("q");
  return (
    <>
      <PageHeader title="Gallery" />
      <input aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      <Photo />
    </>
  );
}

function Stats() {
  const location = useLocation();
  const { t } = useTranslation();
  return (
    <Link to="/gallery?missingDate=1" state={backStateFor(location, t)}>
      Missing date
    </Link>
  );
}

// Real browser history (jsdom's), so the back control's history step and Browser Back are what's tested.
function renderApp(start: string) {
  window.history.replaceState(null, "", start);
  render(
    <BrowserRouter>
      <ToastContext.Provider value={toast}>
        <Where />
        <Routes>
          <Route path="/" element={null} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/trips" element={<Link to="/trips/t1">Big Bend</Link>} />
          <Route
            path="/trips/:id"
            element={
              <>
                <PageHeader title="Big Bend" backFallbackTo="/trips" backLabel="Trips" />
                <Photo backLabel="Big Bend" />
              </>
            }
          />
          <Route
            path="/albums/:id"
            element={
              <>
                <PageHeader title="Spring" backFallbackTo="/albums" backLabel="Albums" />
                <Photo backLabel="Spring" />
              </>
            }
          />
          <Route path="/species/:id" element={<PageHeader backFallbackTo="/" />} />
        </Routes>
      </ToastContext.Provider>
    </BrowserRouter>,
  );
}

const at = (path: string) => waitFor(() => expect(screen.getByText(`at ${path}`)).toBeTruthy());
const openSpecies = () => fireEvent.click(screen.getByRole("link", { name: /View species/ }));

describe("back navigation", () => {
  it("returns from a Gallery photo's species to the same search", async () => {
    renderApp("/gallery?q=water");
    openSpecies();
    await at("/species/sp1");
    fireEvent.click(screen.getByRole("button", { name: "← Gallery" }));
    await at("/gallery?q=water");
  });

  it("returns from a trip photo's species to the trip, then to Trips", async () => {
    renderApp("/trips");
    fireEvent.click(screen.getByRole("link", { name: "Big Bend" }));
    await at("/trips/t1");
    openSpecies();
    await at("/species/sp1");

    fireEvent.click(screen.getByRole("button", { name: "← Big Bend" }));
    await at("/trips/t1");
    fireEvent.click(screen.getByRole("button", { name: "← Trips" }));
    await at("/trips");
    // Nothing extra was stacked: Browser Back from here leaves the app's first page.
    expect(window.history.state.idx).toBe(0);
  });

  it("returns from an album photo's species to the album", async () => {
    renderApp("/albums/a1");
    openSpecies();
    await at("/species/sp1");
    fireEvent.click(screen.getByRole("button", { name: "← Spring" }));
    await at("/albums/a1");
    expect(screen.getByRole("button", { name: "← Albums" })).toBeTruthy();
  });

  it("keeps naming Stats on the Gallery it opened after the search changes", async () => {
    renderApp("/stats");
    fireEvent.click(screen.getByRole("link", { name: "Missing date" }));
    await at("/gallery?missingDate=1");

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "heron" } });
    await at("/gallery?missingDate=1&q=heron");
    fireEvent.click(screen.getByRole("button", { name: "← Stats" }));
    await at("/stats");
  });

  it("falls back to the logical parent when the page was opened directly", async () => {
    renderApp("/trips/t1");
    fireEvent.click(screen.getByRole("button", { name: "← Trips" }));
    await at("/trips");
  });
});
