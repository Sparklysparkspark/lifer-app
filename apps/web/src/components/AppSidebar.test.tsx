// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const app = { id: "com.example.sort", name: "Example", label: "Sort", icon: "M0 0h1v1z", downloads: {} };
vi.mock("../lib/suggestedApps", () => ({
  SUGGESTED_APPS: [app],
  offerPath: (id: string) => `/apps/offer/${id}`,
  useSuggestedApps: () => [app],
}));

const { SuggestedLinks } = await import("./AppSidebar");

afterEach(cleanup);

it("a suggested app keeps its short label and names the app in its description", () => {
  render(
    <MemoryRouter>
      <SuggestedLinks />
    </MemoryRouter>,
  );
  const link = screen.getByRole("link", { name: "Sort" });
  const description = document.getElementById(link.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toBe("Sort with Example");
});
