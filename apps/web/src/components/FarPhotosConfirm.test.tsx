// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FarPhotosConfirm from "./FarPhotosConfirm";

afterEach(cleanup);

describe("FarPhotosConfirm", () => {
  it("lays out Cancel, then Move these too, then the primary, right-aligned", () => {
    const onFile = vi.fn();
    render(
      <FarPhotosConfirm
        far={{ spotId: "s", captureIds: ["a", "b", "c"], count: 3, km: 40 }}
        busy={false}
        onFile={onFile}
        onCancel={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", expect.any(String), expect.any(String)]);
    expect(buttons[0].parentElement!.className).toContain("justify-end");
    fireEvent.click(buttons[2]);
    expect(onFile).toHaveBeenCalledWith(false);
    fireEvent.click(buttons[1]);
    expect(onFile).toHaveBeenCalledWith(true);
  });
});
