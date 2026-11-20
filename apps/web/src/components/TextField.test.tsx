// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NameField } from "./TextField";

describe("NameField", () => {
  it("caps the name at 255 characters", () => {
    render(<NameField value="" onChange={() => {}} aria-label="Name" />);
    expect(screen.getByLabelText("Name").getAttribute("maxlength")).toBe("255");
  });

  it("counts down only near the limit", () => {
    const { rerender } = render(<NameField value={"a".repeat(199)} onChange={() => {}} aria-label="Name" />);
    expect(screen.queryByText(/left/)).toBeNull();
    rerender(<NameField value={"a".repeat(200)} onChange={() => {}} aria-label="Name" />);
    expect(screen.getByText("55 characters left")).toBeTruthy();
    rerender(<NameField value={"a".repeat(254)} onChange={() => {}} aria-label="Name" />);
    expect(screen.getByText("1 character left")).toBeTruthy();
  });
});
