// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { preloadablePage } from "./preloadablePage";

const Hello = () => <p>Hello</p>;

describe("preloadablePage", () => {
  it("renders a preloaded page in the first render, without its fallback", async () => {
    const Page = preloadablePage(() => Promise.resolve({ default: Hello }));
    await Page.preload();
    render(
      <Suspense fallback={<p>Loading</p>}>
        <Page />
      </Suspense>,
    );
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.queryByText("Loading")).toBeNull();
  });

  it("still loads a page nobody preloaded", async () => {
    const Page = preloadablePage(() => Promise.resolve({ default: Hello }));
    render(
      <Suspense fallback={<p>Loading</p>}>
        <Page />
      </Suspense>,
    );
    expect(screen.getByText("Loading")).toBeTruthy();
    await act(async () => {});
    expect(await screen.findByText("Hello")).toBeTruthy();
  });
});
