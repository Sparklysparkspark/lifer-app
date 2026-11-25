// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { useBurstScope, type BurstEdit } from "./useBurstScope";

const frame = (id: string, lat: number | null) => ({ captureId: id, lat });
let scene: unknown = null;
vi.mock("../lib/resource", () => ({ useApiRoute: (path: string | null) => ({ data: path ? scene : null }) }));

function Harness({ kind, id }: { kind: BurstEdit; id: string }) {
  const { ids, control } = useBurstScope(kind, id, {
    has: (f) => f.lat != null,
    text: (count) => `${count} already have coordinates`,
  });
  return (
    <>
      {control}
      <output data-testid="ids">{ids.join(",")}</output>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  scene = {
    burst: ["a", "b", "c"],
    scene: [
      { burstId: "a", frames: [frame("a", 1), frame("b", null), frame("c", 2)] },
      { burstId: "d", frames: [frame("d", 1)] },
    ],
  };
});
afterEach(cleanup);

describe("useBurstScope", () => {
  it("applies to the whole burst by default, says how many and how many have the value, and remembers an untick", () => {
    const first = render(<Harness kind="coordinates" id="b" />);
    const box = screen.getByRole("checkbox", { name: "Apply to all 3 photos in this burst" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText("2 already have coordinates")).toBeTruthy();
    expect(screen.getByTestId("ids").textContent).toBe("a,b,c");
    fireEvent.click(box);
    expect(screen.getByTestId("ids").textContent).toBe("b");
    first.unmount();
    render(<Harness kind="coordinates" id="b" />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("offers nothing for a photo alone, and edits just that photo", () => {
    scene = { burst: ["d"], scene: [{ burstId: "d", frames: [frame("d", 1)] }] };
    render(<Harness kind="species" id="d" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByTestId("ids").textContent).toBe("d");
  });
});
