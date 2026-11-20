// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import FolderPath from "./FolderPath";

const parts = (path: string) =>
  [...render(<FolderPath path={path} />).container.firstElementChild!.children].map((el) => el.textContent);

describe("FolderPath", () => {
  it.each([
    ["/Users/me/Pictures/Lifer", ["Lifer", "/Users/me/Pictures"]],
    ["/Users/me/Pictures/Lifer/", ["Lifer", "/Users/me/Pictures"]],
    ["C:\\Users\\me\\Lifer", ["Lifer", "C:\\Users\\me"]],
    ["/Lifer", ["Lifer", "/"]],
    ["Lifer", ["Lifer"]],
  ])("splits %s into the folder and where it is", (path, expected) => {
    expect(parts(path)).toEqual(expected);
  });

  it("keeps the full path on hover", () => {
    const { container } = render(<FolderPath path="/data/lifer" />);
    expect(container.firstElementChild!.getAttribute("title")).toBe("/data/lifer");
  });
});
