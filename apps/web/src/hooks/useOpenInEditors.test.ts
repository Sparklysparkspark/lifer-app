import { describe, expect, it } from "vitest";
import { orderEditors } from "./useOpenInEditors";

// As the desktop app lists them: Lifer's suggested order, the system default last.
const editors = [
  { id: "lightroom-classic", name: "Lightroom Classic" },
  { id: "darktable", name: "darktable" },
  { id: "photoshop", name: "Photoshop" },
  { id: "system", name: "System default" },
];

describe("orderEditors", () => {
  it("puts the chosen editor first and keeps the rest in order", () => {
    expect(orderEditors(editors, "photoshop").map((e) => e.id)).toEqual([
      "photoshop",
      "lightroom-classic",
      "darktable",
      "system",
    ]);
  });

  it("leads with the first editor found, not the system default, when none is chosen or it is gone", () => {
    expect(orderEditors(editors, null)[0].id).toBe("lightroom-classic");
    expect(orderEditors(editors, "capture-one")[0].id).toBe("lightroom-classic");
  });
});
