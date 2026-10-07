import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaFilterField, PhotoSortSelect, RawFilterField } from "./PhotoGridControls";

const noop = () => {};

// No DOM here: these check the rendered markup gives each filter control an accessible name, since
// the visible heading above a pill row is a plain <p> a screen reader doesn't tie to it.
describe("photo grid filter controls", () => {
  it("names the RAW and media pill rows as groups", () => {
    expect(renderToStaticMarkup(<RawFilterField value="any" onChange={noop} />)).toMatch(
      /^<div role="group" aria-label="RAW files">/,
    );
    expect(renderToStaticMarkup(<MediaFilterField value="both" onChange={noop} />)).toMatch(
      /^<div role="group" aria-label="Media type">/,
    );
  });

  it("wraps the sort select in its label", () => {
    expect(renderToStaticMarkup(<PhotoSortSelect value="newest" onChange={noop} />)).toMatch(
      /^<label[^>]*>Sort<select/,
    );
  });
});
