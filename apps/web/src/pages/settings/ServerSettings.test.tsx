// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { AutomaticUrlSwitchingRows } = await import("./ServerSettings");

beforeEach(() => {
  (window as unknown as { liferSetup: unknown }).liferSetup = {
    getConfig: () =>
      Promise.resolve({
        mode: "remote",
        serverUrl: "http://192.168.1.5:4310",
        localUrl: "http://192.168.1.5:4310",
        externalUrls: ["https://a.example", "https://b.example"],
      }),
    testEndpoint: vi.fn(() => Promise.resolve(true)),
  };
});

const urls = () =>
  within(screen.getAllByRole("list")[0])
    .getAllByRole("listitem")
    .map((li) => li.textContent?.match(/https:\/\/\w+\.example/)?.[0]);

describe("Automatic URL switching", () => {
  it("reorders from the keyboard with Move up and Move down", async () => {
    render(<AutomaticUrlSwitchingRows />);
    fireEvent.click(await screen.findByRole("button", { name: "Move https://b.example up" }));
    expect(urls()).toEqual(["https://b.example", "https://a.example"]);
    expect(screen.getByRole("button", { name: "Move https://b.example up" })).toHaveProperty("disabled", true);
  });

  it("adds with Enter and says when an address is already listed", async () => {
    render(<AutomaticUrlSwitchingRows />);
    const field = await screen.findByRole("textbox", { name: "New address" });
    fireEvent.change(field, { target: { value: "https://a.example" } });
    fireEvent.submit(field.closest("form")!);
    expect(await screen.findByText("Already listed")).toBeTruthy();
    fireEvent.change(field, { target: { value: "https://c.example" } });
    fireEvent.submit(field.closest("form")!);
    await vi.waitFor(() => expect(urls()).toEqual(["https://a.example", "https://b.example", "https://c.example"]));
  });
});
