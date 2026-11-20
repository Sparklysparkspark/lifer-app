// @vitest-environment jsdom
// The overlay pills over a photo (Preview, the ⋯ menu) are one box: same classes, same glyph size.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IconButton } from "./Button";
import Menu, { MenuItems, MenuPanel } from "./Menu";
import MagnifierIcon from "./MagnifierIcon";

afterEach(cleanup);

describe("overlay pills", () => {
  it("draw Preview and ⋯ as the same box with the same glyph size", () => {
    render(
      <div className="group relative">
        <IconButton tone="overlay" aria-label="Preview">
          <MagnifierIcon />
        </IconButton>
        <Menu open={false} onToggle={() => {}}>
          <MenuPanel>
            <MenuItems items={[]} />
          </MenuPanel>
        </Menu>
      </div>,
    );
    const preview = screen.getByRole("button", { name: "Preview" });
    const more = screen.getByRole("button", { name: "More options" });
    const size = (el: HTMLElement) =>
      el.className
        .split(/\s+/)
        .filter((c) => /^(h-|w-|min-w-|px-|rounded-|gap-|border)/.test(c))
        .sort();
    expect(size(more)).toEqual(size(preview));
    expect(more.querySelector("svg")?.getAttribute("class")).toBe(preview.querySelector("svg")?.getAttribute("class"));
  });
});
