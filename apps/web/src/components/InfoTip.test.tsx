// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InfoTip from "./InfoTip";

describe("InfoTip", () => {
  it("toggles its text, closes on Escape, and only one is open at a time", () => {
    render(
      <>
        <InfoTip paragraphs={["First help"]} />
        <InfoTip paragraphs={["Second help"]} />
      </>,
    );
    const [a, b] = screen.getAllByRole("button", { name: /more info/i });
    fireEvent.click(a);
    expect(screen.getByText("First help")).toBeTruthy();
    fireEvent.click(b);
    expect(screen.queryByText("First help")).toBeNull();
    expect(screen.getByText("Second help")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Second help")).toBeNull();
  });
});

describe("InfoTip placement", () => {
  it("renders on the page top layer, outside a clipping parent, inside the window", () => {
    render(
      <div data-testid="clip" style={{ overflow: "hidden", width: 40, height: 20 }}>
        <InfoTip paragraphs={["Help"]} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /more info/i }));
    const tip = screen.getByText("Help").parentElement!;
    expect(screen.getByTestId("clip").contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
    const left = parseFloat(tip.style.left);
    const width = parseFloat(tip.style.width);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(window.innerWidth);
  });

  it("returns focus to the dot on Escape", () => {
    render(<InfoTip paragraphs={["Help"]} />);
    const btn = screen.getByRole("button", { name: /more info/i });
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(btn);
  });
});
