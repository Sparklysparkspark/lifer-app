// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SpeciesNameText from "./SpeciesNameText";

describe("SpeciesNameText", () => {
  it("joins the parts with a middle dot, each keeping its own style", () => {
    const { container } = render(
      <p>
        <SpeciesNameText
          parts={[
            { text: "Turdus migratorius", kind: "scientific" },
            { text: "AMRO", kind: "code" },
          ]}
        />
      </p>,
    );
    expect(container.textContent).toBe("Turdus migratorius · AMRO");
    const [name, code] = container.querySelectorAll("span");
    expect(name.className).toBe("italic");
    expect(code.className).toContain("uppercase");
  });
});
