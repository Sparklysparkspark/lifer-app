// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MapSettingsRows from "./MapSettingsRows";

afterEach(() => localStorage.clear());

const field = () => screen.getByLabelText("Satellite imagery URL") as HTMLInputElement;

describe("MapSettingsRows imagery URL", () => {
  it("masks the address, which usually holds a key, with a way to show it", () => {
    render(<MapSettingsRows />);
    expect(field().type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field().type).toBe("text");
  });

  it("saves a usable address on blur and keeps an unusable one out", () => {
    render(<MapSettingsRows />);
    fireEvent.change(field(), { target: { value: "http://not-https/{z}" } });
    fireEvent.blur(field());
    expect(localStorage.getItem("lifer:photo-map-satellite-url")).toBeNull();
    expect(screen.getByText(/Use an https address/)).toBeTruthy();
    const url = "https://api.example.com/{z}/{x}/{y}.jpg?key=k";
    fireEvent.change(field(), { target: { value: url } });
    fireEvent.blur(field());
    expect(localStorage.getItem("lifer:photo-map-satellite-url")).toBe(JSON.stringify(url));
  });
});
