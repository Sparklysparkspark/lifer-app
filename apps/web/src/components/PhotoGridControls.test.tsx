// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { PhotoCaptionPrefs } from "../hooks/usePhotoCaptionPrefs";
import { MediaFilterField, PhotoCaptionOptions, PhotoViewMenu, RawFilterFields, ShowField } from "./PhotoGridControls";

const noop = () => {};

// No DOM here: these check the rendered markup gives each filter control an accessible name, since
// the visible heading above a pill row is a plain <p> a screen reader doesn't tie to it.
describe("photo grid filter controls", () => {
  it("names the RAW and media pill rows as groups", () => {
    const raw = renderToStaticMarkup(
      <RawFilterFields rawFiles="show" editedRaw="any" onRawFilesChange={noop} onEditedRawChange={noop} />,
    );
    expect(raw).toMatch(/^<div role="group" aria-label="RAW files">/);
    expect(raw).toContain('<div role="group" aria-label="Edited photos">');
    expect(renderToStaticMarkup(<MediaFilterField value="both" onChange={noop} />)).toMatch(
      /^<div role="group" aria-label="Media type">/,
    );
  });

  it("names the Show switch as a group", () => {
    expect(renderToStaticMarkup(<ShowField view="gallery" onChange={noop} />)).toMatch(
      /^<div role="group" aria-label="Show">/,
    );
  });

  it("offers the same three caption choices on every page", () => {
    const prefs = { showLabels: true, showCameraInfo: false, showRatings: true } as PhotoCaptionPrefs;
    const html = renderToStaticMarkup(<PhotoCaptionOptions prefs={prefs} />);
    expect([...html.matchAll(/<input[^>]*>([^<]+)<\/label>/g)].map((m) => m[1])).toEqual([
      "Labels",
      "Camera info",
      "Ratings",
    ]);
  });
});

describe("View menu", () => {
  it("shows only the declared sections, each with its one label", () => {
    const prefs = { showLabels: true, showCameraInfo: false, showRatings: true } as PhotoCaptionPrefs;
    render(
      <MemoryRouter>
        <PhotoViewMenu
          sections={["sort", "captions"]}
          activeCount={0}
          sort={{ value: "rating", options: ["newest", "rating"], onChange: noop }}
          size={{ value: 200, onChange: noop }}
          captions={prefs}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const sort = screen.getByRole("combobox", { name: "Sort" });
    expect([...sort.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Newest first",
      "Highest rated first",
    ]);
    // Size was configured but not declared.
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Ratings" })).toBeTruthy();
  });

  it("toggles the map pins, and leaves them out with no map to pin on", () => {
    const changes: boolean[] = [];
    const { unmount } = render(
      <MemoryRouter>
        <PhotoViewMenu
          sections={["hideNames", "mapPins"]}
          activeCount={0}
          mapPins={{ checked: true, onChange: (c) => changes.push(c) }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show map pins" }));
    expect(changes).toEqual([false]);
    unmount();
    render(
      <MemoryRouter>
        <PhotoViewMenu sections={["hideNames", "mapPins"]} activeCount={0} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByRole("checkbox", { name: "Show map pins" })).toBeNull();
  });
});

describe("smart album rules line", () => {
  it("formats a large left-out count for the locale", () => {
    expect(i18n.t("albums.smart.excludedCount", { count: 1204 })).toBe("1,204 excluded");
    expect(i18n.t("albums.smart.restoreCount", { count: 12345 })).toBe("Put back 12,345 photos");
  });
});
