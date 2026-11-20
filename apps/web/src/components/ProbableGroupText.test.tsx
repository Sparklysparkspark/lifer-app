// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProbableGroupText, { type ProbableGroup } from "./ProbableGroupText";

const text = (group: ProbableGroup) => {
  const { container } = render(
    <p>
      <ProbableGroupText group={group} />
    </p>,
  );
  return { text: container.textContent, italic: container.querySelector("i")?.textContent };
};

describe("ProbableGroupText", () => {
  it("names the genus in italics", () => {
    expect(text({ rank: "genus", name: "Myotis", taxonClass: "mammalia" })).toEqual({
      text: "Probably a Myotis",
      italic: "Myotis",
    });
  });

  it("uses an before a vowel", () => {
    expect(text({ rank: "genus", name: "Eptesicus", taxonClass: "mammalia" }).text).toBe("Probably an Eptesicus");
  });

  it("words a family as a family", () => {
    expect(text({ rank: "family", name: "Vespertilionidae", taxonClass: "mammalia" })).toEqual({
      text: "Probably in the family Vespertilionidae",
      italic: "Vespertilionidae",
    });
  });
});
