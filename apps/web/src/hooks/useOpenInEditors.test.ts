import { describe, expect, it } from "vitest";
import { orderEditors } from "./useOpenInEditors";

const editors = [
  { id: "photoshop", name: "Photoshop" },
  { id: "gimp", name: "GIMP" },
  { id: "system", name: "System default" },
];

describe("orderEditors", () => {
  it("puts the last-used editor first and keeps the rest in order", () => {
    expect(orderEditors(editors, "gimp").map((e) => e.id)).toEqual(["gimp", "photoshop", "system"]);
  });

  it("keeps the order when nothing was used or it is gone", () => {
    expect(orderEditors(editors, null).map((e) => e.id)).toEqual(["photoshop", "gimp", "system"]);
    expect(orderEditors(editors, "affinity").map((e) => e.id)).toEqual(["photoshop", "gimp", "system"]);
  });
});
