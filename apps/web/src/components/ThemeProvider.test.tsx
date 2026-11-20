// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "./ThemeProvider";
import { useTheme } from "../hooks/useTheme";

function Probe() {
  const { theme, preference } = useTheme();
  return <p>{`${preference}:${theme}`}</p>;
}

function systemIsDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("ThemeProvider", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove("dark");
  });

  it("follows the system on first launch", () => {
    systemIsDark(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByText("system:dark")).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps a saved choice over the system", () => {
    systemIsDark(true);
    localStorage.setItem("lifer-theme", "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByText("light:light")).toBeTruthy();
  });
});
